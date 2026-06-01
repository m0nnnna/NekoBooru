import subprocess
import shutil
import logging
from pathlib import Path
from PIL import Image

from ..config import settings

logger = logging.getLogger(__name__)


def check_ffmpeg_available() -> bool:
    """Check if ffmpeg is available in the system PATH."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            timeout=5,
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
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-show_entries", "format=duration",
                "-of", "csv=p=0:s=x",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split("\n")
            if len(lines) >= 2:
                # First line: width x height
                dimensions = lines[0].split("x")
                width = int(dimensions[0]) if dimensions[0] else 0
                height = int(dimensions[1]) if len(dimensions) > 1 and dimensions[1] else 0
                # Second line: duration
                duration = float(lines[1]) if lines[1] else None
                return {"width": width, "height": height, "duration": duration}
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError):
        pass
    return {"width": None, "height": None, "duration": None}


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
        result = subprocess.run(cmd, capture_output=True, timeout=30)
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
        result = subprocess.run(cmd, capture_output=True, timeout=120)
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
