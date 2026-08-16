import subprocess
import shutil
import logging
import tempfile
import sys
import json
from pathlib import Path
from PIL import Image

from ..config import settings

logger = logging.getLogger(__name__)


def _subprocess_options(**kwargs) -> dict:
    """Run media tools without flashing a console window on Windows."""
    options = dict(kwargs)
    if sys.platform == "win32":
        options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return options


def check_ffmpeg_available() -> bool:
    """Check if ffmpeg is available in the system PATH."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            **_subprocess_options(capture_output=True, timeout=5),
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def get_image_dimensions(file_path: Path) -> tuple[int, int]:
    """Get width and height of an image."""
    with Image.open(file_path) as img:
        return img.size


def get_video_info(file_path: Path) -> dict:
    """Get video dimensions and duration using ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries",
                "stream=codec_type,codec_name,profile,width,height,pix_fmt,avg_frame_rate,bit_rate,field_order,channels",
                "-show_entries", "format=duration,bit_rate",
                "-of", "json",
                str(file_path),
            ],
            **_subprocess_options(capture_output=True, text=True, timeout=30),
        )
        if result.returncode == 0:
            payload = json.loads(result.stdout or "{}")
            streams = payload.get("streams") or []
            stream = next((item for item in streams if item.get("codec_type") == "video"), {})
            audio_stream = next((item for item in streams if item.get("codec_type") == "audio"), {})
            format_info = payload.get("format") or {}
            frame_rate_raw = str(stream.get("avg_frame_rate") or "0/0")
            numerator, _, denominator = frame_rate_raw.partition("/")
            try:
                frame_rate = float(numerator) / float(denominator) if float(denominator) else None
            except (TypeError, ValueError, ZeroDivisionError):
                frame_rate = None
            return {
                "width": int(stream.get("width") or 0) or None,
                "height": int(stream.get("height") or 0) or None,
                "duration": float(format_info["duration"]) if format_info.get("duration") else None,
                "codec": str(stream.get("codec_name") or "").lower() or None,
                "videoBitrateKbps": (
                    round(int(stream["bit_rate"]) / 1000)
                    if stream.get("bit_rate") else None
                ),
                "bitrateKbps": (
                    round(int(format_info["bit_rate"]) / 1000)
                    if format_info.get("bit_rate") else None
                ),
                "profile": str(stream.get("profile") or "") or None,
                "pixelFormat": str(stream.get("pix_fmt") or "").lower() or None,
                "fieldOrder": str(stream.get("field_order") or "").lower() or None,
                "frameRate": frame_rate,
                "audioCodec": str(audio_stream.get("codec_name") or "").lower() or None,
                "audioChannels": int(audio_stream.get("channels") or 0) or None,
            }
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError, json.JSONDecodeError):
        pass
    return {
        "width": None,
        "height": None,
        "duration": None,
        "codec": None,
        "videoBitrateKbps": None,
        "bitrateKbps": None,
        "profile": None,
        "pixelFormat": None,
        "fieldOrder": None,
        "frameRate": None,
        "audioCodec": None,
        "audioChannels": None,
    }


def create_image_thumbnail(source: Path, dest: Path) -> bool:
    """Create thumbnail for an image."""
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as img:
            # Convert to RGB if necessary (for PNG with transparency, etc.)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            # Calculate thumbnail size preserving aspect ratio
            img.thumbnail((settings.thumb_size, settings.thumb_size), Image.Resampling.LANCZOS)
            img.save(dest, "JPEG", quality=settings.thumb_quality)
        return True
    except Exception:
        return False


def create_gif_thumbnail(source: Path, dest: Path) -> bool:
    """Create thumbnail from first frame of GIF."""
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as img:
            img.seek(0)
            # Copy the frame before any conversion so we own the pixel data
            frame = img.copy()
            # Composite onto white background to handle palette + transparency
            bg = Image.new("RGB", frame.size, (255, 255, 255))
            if frame.mode in ("RGBA", "LA"):
                bg.paste(frame, mask=frame.split()[-1])
            elif frame.mode == "P":
                rgba = frame.convert("RGBA")
                bg.paste(rgba, mask=rgba.split()[-1])
            else:
                bg.paste(frame.convert("RGB"))
            bg.thumbnail((settings.thumb_size, settings.thumb_size), Image.Resampling.LANCZOS)
            bg.save(dest, "JPEG", quality=settings.thumb_quality)
        return True
    except Exception:
        return False


def create_video_thumbnail(source: Path, dest: Path) -> bool:
    """Create thumbnail from video using ffmpeg."""
    # Check if ffmpeg is available first
    if not check_ffmpeg_available():
        logger.error(
            "ffmpeg is not installed or not in PATH. "
            "Please install ffmpeg to generate video thumbnails. "
            "Download from: https://ffmpeg.org/download.html"
        )
        return False
    
    def _run_ffmpeg(seek: str | None) -> bool:
        # -ss must come BEFORE -i (input seeking) so the demuxer seeks the
        # container rather than making the decoder walk every frame.  Output
        # seeking (-ss after -i) leaves some H.264 files with "No filtered
        # frames" because the keyframe structure isn't aligned with the seek
        # point.  When seek is None we omit -ss entirely to guarantee frame 0.
        cmd = ["ffmpeg", "-y"]
        if seek is not None:
            cmd += ["-ss", seek]
        cmd += [
            "-i", str(source),
            "-vframes", "1",
            "-vf", (
                f"scale={settings.thumb_size}:{settings.thumb_size}"
                f":force_original_aspect_ratio=decrease"
                f",format=yuvj420p"
            ),
            "-strict", "unofficial",
            "-f", "image2",
            str(dest),
        ]
        result = subprocess.run(cmd, **_subprocess_options(capture_output=True, timeout=30))
        return result.returncode == 0 and dest.exists()

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Try input-seek to 1 s first; for short clips (<1 s) fall back to
        # no seek at all so we always land on a real decoded frame.
        if not _run_ffmpeg("1") and not _run_ffmpeg(None):
            logger.error(f"ffmpeg could not extract a frame from {source}")
            return False
        logger.info(f"Successfully created video thumbnail: {dest}")
        return True
    except subprocess.TimeoutExpired:
        logger.error(f"ffmpeg timed out while creating thumbnail for {source}")
        return False
    except FileNotFoundError:
        logger.error("ffmpeg not found. Please install ffmpeg and ensure it's in your PATH.")
        return False
    except Exception as e:
        logger.error(f"Unexpected error creating video thumbnail: {e}")
        return False


def convert_video_to_gif(source: Path, dest: Path, fps: int = 15, max_width: int = 480) -> bool:
    """Transcode a video (mp4/webm) into an animated GIF using ffmpeg.

    Uses a single-pass palettegen/paletteuse filter graph for good colour
    quality. Output is capped at ``max_width`` px wide and ``fps`` frames per
    second to keep the resulting GIF a sane size.
    """
    if not check_ffmpeg_available():
        logger.error(
            "ffmpeg is not installed or not in PATH. "
            "Please install ffmpeg to convert videos to GIF. "
            "Download from: https://ffmpeg.org/download.html"
        )
        return False

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        vf = (
            f"fps={fps},scale={max_width}:-1:flags=lanczos,"
            f"split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
        )
        cmd = ["ffmpeg", "-y", "-i", str(source), "-vf", vf, "-loop", "0", str(dest)]
        result = subprocess.run(cmd, **_subprocess_options(capture_output=True, timeout=120))
        if result.returncode != 0 or not dest.exists():
            logger.error(f"ffmpeg could not convert {source} to GIF")
            dest.unlink(missing_ok=True)
            return False
        logger.info(f"Successfully converted video to GIF: {dest}")
        return True
    except subprocess.TimeoutExpired:
        logger.error(f"ffmpeg timed out while converting {source} to GIF")
        dest.unlink(missing_ok=True)
        return False
    except FileNotFoundError:
        logger.error("ffmpeg not found. Please install ffmpeg and ensure it's in your PATH.")
        return False
    except Exception as e:
        logger.error(f"Unexpected error converting video to GIF: {e}")
        dest.unlink(missing_ok=True)
        return False


def create_thumbnail(source: Path, dest: Path, extension: str) -> bool:
    """Create appropriate thumbnail based on file type."""
    ext = extension.lower()
    if ext in (".jpg", ".jpeg", ".png", ".webp"):
        return create_image_thumbnail(source, dest)
    elif ext == ".gif":
        return create_gif_thumbnail(source, dest)
    elif ext in (".webm", ".mp4"):
        return create_video_thumbnail(source, dest)
    return False


def optimize_media_to_temp(
    source: Path,
    extension: str,
    image_max_dimension: int | None = None,
    image_quality: int = 85,
    video_max_dimension: int | None = None,
    video_bitrate_kbps: int | None = None,
    social_compatible: bool = False,
    progress=None,
) -> dict:
    """Write an optimized copy of a post media file and return its temp path.

    The caller owns the returned temp file and decides whether to replace the
    stored original after hashing, duplicate checks, and thumbnail generation.
    """
    ext = extension.lower()
    if ext in (".jpg", ".jpeg", ".png", ".webp"):
        return _optimize_image_to_temp(source, ext, image_max_dimension, image_quality)
    if ext == ".gif":
        return _optimize_gif_to_temp(source, ext, image_max_dimension, progress=progress)
    if ext in (".mp4", ".webm"):
        return _optimize_video_to_temp(
            source,
            ext,
            video_max_dimension,
            video_bitrate_kbps,
            social_compatible=social_compatible,
            progress=progress,
        )
    return {"changed": False, "reason": f"{ext or 'file'} is not supported"}


def _temp_output_for(source: Path, extension: str) -> Path:
    handle = tempfile.NamedTemporaryFile(
        prefix=f"{source.stem}.optimized.",
        suffix=extension,
        dir=source.parent,
        delete=False,
    )
    handle.close()
    return Path(handle.name)


def _clamped_dimension(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 64 else None


def _optimize_image_to_temp(source: Path, extension: str, max_dimension: int | None, quality: int) -> dict:
    max_dimension = _clamped_dimension(max_dimension)
    quality = max(1, min(100, int(quality or 85)))
    dest = _temp_output_for(source, extension)
    try:
        with Image.open(source) as img:
            original_size = img.size
            working = img.copy()
            if max_dimension and max(original_size) > max_dimension:
                working.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
            changed_dimensions = working.size != original_size
            if not changed_dimensions and quality >= 100 and extension not in (".png",):
                dest.unlink(missing_ok=True)
                return {"changed": False, "reason": "already within requested limits"}
            save_kwargs = {}
            if extension in (".jpg", ".jpeg"):
                if working.mode in ("RGBA", "P"):
                    working = working.convert("RGB")
                save_kwargs = {"quality": quality, "optimize": True, "progressive": True}
                fmt = "JPEG"
            elif extension == ".webp":
                save_kwargs = {"quality": quality, "method": 6}
                fmt = "WEBP"
            else:
                save_kwargs = {"optimize": True}
                fmt = "PNG"
            working.save(dest, fmt, **save_kwargs)
        if not dest.exists() or dest.stat().st_size <= 0:
            dest.unlink(missing_ok=True)
            return {"changed": False, "reason": "optimizer did not create output"}
        if not max_dimension and dest.stat().st_size >= source.stat().st_size:
            dest.unlink(missing_ok=True)
            return {"changed": False, "reason": "optimized copy was not smaller"}
        return {"changed": True, "path": dest}
    except Exception as exc:
        dest.unlink(missing_ok=True)
        return {"changed": False, "reason": str(exc)}


def _optimize_gif_to_temp(source: Path, extension: str, max_dimension: int | None, progress=None) -> dict:
    max_dimension = _clamped_dimension(max_dimension)
    if not max_dimension:
        return {"changed": False, "reason": "GIF optimization needs a max dimension"}
    if not check_ffmpeg_available():
        return {"changed": False, "reason": "ffmpeg is not available"}
    dest = _temp_output_for(source, extension)
    vf = (
        f"scale=w='if(gt(iw,ih),min({max_dimension},iw),-2)':"
        f"h='if(gt(iw,ih),-2,min({max_dimension},ih))':flags=lanczos"
    )
    cmd = ["ffmpeg", "-y", "-i", str(source), "-vf", vf, "-loop", "0", str(dest)]
    try:
        if progress:
            progress(8, "Optimizing GIF")
        result = subprocess.run(cmd, **_subprocess_options(capture_output=True, timeout=180))
        if progress:
            progress(96, "Finalizing GIF")
        if result.returncode != 0 or not dest.exists() or dest.stat().st_size <= 0:
            dest.unlink(missing_ok=True)
            return {"changed": False, "reason": "ffmpeg could not optimize GIF"}
        return {"changed": True, "path": dest}
    except Exception as exc:
        dest.unlink(missing_ok=True)
        return {"changed": False, "reason": str(exc)}


def _optimize_video_to_temp(
    source: Path,
    extension: str,
    max_dimension: int | None,
    bitrate_kbps: int | None,
    social_compatible: bool = False,
    progress=None,
) -> dict:
    max_dimension = _clamped_dimension(max_dimension)
    bitrate_kbps = int(bitrate_kbps or 0)
    if not social_compatible and not max_dimension and bitrate_kbps <= 0:
        return {"changed": False, "reason": "no video resize or bitrate limit requested"}
    if not check_ffmpeg_available():
        return {"changed": False, "reason": "ffmpeg is not available"}

    source_info = get_video_info(source)
    duration = source_info.get("duration") or 0
    source_codec = str(source_info.get("codec") or "").lower()
    source_width = int(source_info.get("width") or 0)
    source_height = int(source_info.get("height") or 0)
    source_max_dimension = max(
        source_width,
        source_height,
    )
    source_video_bitrate = int(source_info.get("videoBitrateKbps") or 0)
    output_extension = ".mp4" if social_compatible else extension
    dest = _temp_output_for(source, output_extension)

    if social_compatible:
        frame_rate = float(source_info.get("frameRate") or 0)
        audio_codec = str(source_info.get("audioCodec") or "").lower()
        audio_channels = int(source_info.get("audioChannels") or 0)
        pixel_format = str(source_info.get("pixelFormat") or "").lower()
        field_order = str(source_info.get("fieldOrder") or "").lower()
        if source_width >= source_height:
            max_width, max_height = 1920, 1200
        else:
            max_width, max_height = 1200, 1900
        within_dimensions = (
            source_width > 0
            and source_height > 0
            and source_width <= max_width
            and source_height <= max_height
        )
        already_compatible = (
            extension == ".mp4"
            and source_codec == "h264"
            and pixel_format == "yuv420p"
            and within_dimensions
            and (not frame_rate or frame_rate <= 40.01)
            and field_order in {"", "unknown", "progressive"}
            and (not audio_codec or (audio_codec == "aac" and (not audio_channels or audio_channels <= 2)))
        )
        if already_compatible:
            dest.unlink(missing_ok=True)
            return {
                "changed": False,
                "reason": "video is already an X-compatible H.264/AAC MP4",
                "extension": ".mp4",
                "compatibility": "social",
            }

        target_width = source_width
        target_height = source_height
        if source_width > 0 and source_height > 0:
            scale_ratio = min(1.0, max_width / source_width, max_height / source_height)
            target_width = max(2, int(source_width * scale_ratio) // 2 * 2)
            target_height = max(2, int(source_height * scale_ratio) // 2 * 2)
        filters = []
        if target_width != source_width or target_height != source_height:
            filters.append(f"scale={target_width}:{target_height}:flags=lanczos")
        if frame_rate > 40.01:
            filters.append("fps=40")

        output_frame_rate = min(frame_rate, 40.0) if frame_rate > 0 else 30.0
        gop_size = max(24, round(output_frame_rate * 3))
        # Modern codecs are substantially more storage-efficient than H.264.
        # CRF 18 can make a compatibility copy several times larger without a
        # meaningful visual benefit, so use a codec-aware quality target.
        social_crf = 23 if source_codec == "av1" else 22 if source_codec in {"vp9", "hevc", "h265"} else 20
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-nostats", "-i", str(source),
            "-map", "0:v:0",
            "-map", "0:a:0?",
        ]
        if filters:
            cmd += ["-vf", ",".join(filters)]
        cmd += [
            "-c:v", "libx264",
            "-preset", "slow",
            "-crf", str(social_crf),
            "-profile:v", "high",
            "-level:v", "4.2",
            "-pix_fmt", "yuv420p",
            "-maxrate", "25M",
            "-bufsize", "50M",
            "-g", str(gop_size),
            "-keyint_min", str(max(12, gop_size // 2)),
            "-x264-params", "open-gop=0:scenecut=40:aq-mode=3:aq-strength=1.0",
            "-flags", "+cgop",
            "-fps_mode", "cfr",
            "-c:a", "aac",
            "-profile:a", "aac_low",
            "-b:a", "128k",
            "-ac", "2",
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            str(dest),
        ]
    else:
        cmd = ["ffmpeg", "-y", "-hide_banner", "-nostats", "-i", str(source)]

    will_resize = bool(max_dimension and source_max_dimension > max_dimension)
    if (
        not social_compatible
        and not will_resize
        and bitrate_kbps > 0
        and source_video_bitrate > 0
        and bitrate_kbps >= round(source_video_bitrate * 0.94)
    ):
        dest.unlink(missing_ok=True)
        return {
            "changed": False,
            "reason": (
                f"source {source_codec.upper() or 'video'} is already efficiently encoded; "
                "keeping the original avoids generational quality loss"
            ),
        }

    if not social_compatible and max_dimension:
        vf = (
            f"scale=w='if(gt(iw,ih),min({max_dimension},iw),-2)':"
            f"h='if(gt(iw,ih),-2,min({max_dimension},ih))':flags=lanczos"
        )
        cmd += ["-vf", vf]
    if social_compatible:
        pass
    elif source_codec == "av1":
        cmd += [
            "-c:v", "libaom-av1",
            "-usage", "good",
            "-cpu-used", "5",
            "-row-mt", "1",
            "-crf", "24",
        ]
        if bitrate_kbps > 0:
            cmd += [
                "-b:v", f"{bitrate_kbps}k",
                "-maxrate", f"{bitrate_kbps * 2}k",
                "-bufsize", f"{bitrate_kbps * 4}k",
            ]
        else:
            cmd += ["-b:v", "0"]
        if extension == ".webm":
            cmd += ["-c:a", "libopus", "-b:a", "96k"]
        else:
            cmd += ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
    elif extension == ".mp4" and source_codec in {"hevc", "h265"}:
        cmd += [
            "-c:v", "libx265",
            "-preset", "slow",
            "-tag:v", "hvc1",
        ]
        if bitrate_kbps > 0:
            cmd += [
                "-b:v", f"{bitrate_kbps}k",
                "-maxrate", f"{bitrate_kbps * 2}k",
                "-bufsize", f"{bitrate_kbps * 4}k",
            ]
        else:
            cmd += ["-crf", "20"]
        cmd += ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
    elif extension == ".webm":
        cmd += [
            "-c:v", "libvpx-vp9",
            "-deadline", "good",
            "-cpu-used", "2",
            "-row-mt", "1",
            "-crf", "24",
        ]
        if bitrate_kbps > 0:
            cmd += [
                "-b:v", f"{bitrate_kbps}k",
                "-maxrate", f"{bitrate_kbps * 2}k",
                "-bufsize", f"{bitrate_kbps * 4}k",
            ]
        else:
            cmd += ["-b:v", "0"]
        cmd += ["-c:a", "libopus", "-b:a", "96k"]
    else:
        cmd += [
            "-c:v", "libx264",
            "-preset", "slow",
            "-x264-params", "aq-mode=3:aq-strength=1.0",
        ]
        if bitrate_kbps > 0:
            # The selected value is an average budget. Complex motion may
            # briefly use up to 2x that budget, avoiding a CBR-like quality
            # collapse while still producing predictable storage savings.
            cmd += [
                "-b:v", f"{bitrate_kbps}k",
                "-maxrate", f"{bitrate_kbps * 2}k",
                "-bufsize", f"{bitrate_kbps * 4}k",
            ]
        else:
            cmd += ["-crf", "19"]
        cmd += ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
    if not social_compatible:
        cmd += ["-progress", "pipe:1", str(dest)]

    try:
        result = _run_ffmpeg_with_progress(cmd, duration=float(duration or 0), timeout=900, progress=progress)
        if result != 0 or not dest.exists() or dest.stat().st_size <= 0:
            dest.unlink(missing_ok=True)
            return {"changed": False, "reason": "ffmpeg could not optimize video"}
        if not social_compatible and dest.stat().st_size >= source.stat().st_size:
            dest.unlink(missing_ok=True)
            return {
                "changed": False,
                "reason": "quality-preserving encode would not reduce the file size",
            }
        return {
            "changed": True,
            "path": dest,
            "extension": output_extension,
            **(
                {
                    "compatibility": "social",
                    "sourceCodec": source_codec or None,
                    "sourceBitrateKbps": source_video_bitrate or None,
                    "qualityCrf": social_crf,
                }
                if social_compatible else {}
            ),
        }
    except Exception as exc:
        dest.unlink(missing_ok=True)
        return {"changed": False, "reason": str(exc)}


def _run_ffmpeg_with_progress(cmd: list[str], duration: float, timeout: int, progress=None) -> int:
    proc = subprocess.Popen(
        cmd,
        **_subprocess_options(
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        ),
    )
    try:
        last_percent = 0
        assert proc.stdout is not None
        for line in proc.stdout:
            key, _, value = line.strip().partition("=")
            if key == "out_time_ms" and duration > 0:
                try:
                    seconds = int(value) / 1_000_000
                    percent = max(0, min(99, int((seconds / duration) * 100)))
                except ValueError:
                    continue
                if progress and percent > last_percent:
                    last_percent = percent
                    progress(percent, f"Transcoding video {percent}%")
            elif key == "progress" and value == "end" and progress:
                progress(99, "Finalizing video")
        return proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise


def get_media_info(file_path: Path, extension: str) -> dict:
    """Get media dimensions and duration."""
    ext = extension.lower()
    if ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        try:
            width, height = get_image_dimensions(file_path)
            return {"width": width, "height": height, "duration": None}
        except Exception:
            return {"width": None, "height": None, "duration": None}
    elif ext in (".webm", ".mp4"):
        return get_video_info(file_path)
    return {"width": None, "height": None, "duration": None}


def move_to_storage(source: Path, sha256: str, extension: str) -> Path:
    """Move file to content-addressable storage."""
    # Create subdirectory based on first 2 chars of hash
    subdir = settings.posts_dir / sha256[:2]
    subdir.mkdir(parents=True, exist_ok=True)

    dest = subdir / f"{sha256}{extension}"
    shutil.move(str(source), str(dest))
    return dest
