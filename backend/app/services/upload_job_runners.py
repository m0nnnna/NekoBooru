"""The upload-job stage runners: direct and fediverse fetches, yt-dlp section downloads,
ffmpeg sample/render passes, artifact bookkeeping and output verification.

Imported by upload_jobs, which re-exports every name here. Everything this module
needs from upload_jobs is looked up as ``jobs.<name>`` at call time, so a patch on
``app.services.upload_jobs.<name>`` still reaches these runners.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import aiofiles
import httpx
from sqlalchemy import select

from ..config import settings
from ..database import async_session
from ..models import UploadArtifact
from .media import get_video_info
from . import upload_jobs as jobs


async def _run_direct(job_id: str, cancel: threading.Event) -> None:
    part: Path | None = None
    try:
        job = await jobs.get_job(job_id)
        if not job:
            return
        await jobs.update_job(job_id, status="downloading", operation="direct", ready_for=None, stages=jobs._stages("direct"), overall_progress=0, message="Resolving direct media URL", error=None, cancel_requested=False)
        await jobs.set_progress(job_id, "direct", "resolve", 5, "Resolving direct media URL")
        directory = jobs._job_dir(job_id)
        async with jobs._network_slots:
            async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
                async with client.stream("GET", job.source_url or "", headers={"User-Agent": "NekoBooru/4 remote-ingest", "Accept": "image/*,video/*,*/*"}) as response:
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").split(";", 1)[0]
                    extension = jobs._media_extension(urlparse(str(response.url)).path, content_type)
                    total = int(response.headers.get("content-length") or 0)
                    if total > settings.max_upload_size:
                        raise jobs.JobError("upload_too_large", "The remote file exceeds the configured upload limit.")
                    part = directory / f"source.part{extension}"
                    final = directory / f"source{extension}"
                    transferred = 0
                    await jobs.set_progress(job_id, "direct", "download", 10, "Downloading remote media")
                    async with aiofiles.open(part, "wb") as handle:
                        async for chunk in response.aiter_bytes(256 * 1024):
                            if cancel.is_set():
                                raise jobs.JobCancelled()
                            transferred += len(chunk)
                            if transferred > settings.max_upload_size:
                                raise jobs.JobError("upload_too_large", "The remote file exceeds the configured upload limit.")
                            await handle.write(chunk)
                            percent = min(99, int(transferred / total * 100)) if total else 1
                            await jobs.set_progress(job_id, "direct", "download", 10 + int(percent * 0.8), "Downloading remote media", metrics={"downloadedBytes": transferred, "totalBytes": total or None})
        if transferred == 0:
            raise jobs.JobError("empty_download", "The remote server returned an empty file.")
        await jobs.set_progress(job_id, "direct", "register", 95, "Registering remote upload")
        part.replace(final)
        filename = Path(urlparse(job.source_url or "").path).name or f"download{extension}"
        await _register_artifact(job_id, "source", final, filename, {"mimeType": content_type, "sourceUrl": str(response.url)})
        await jobs.update_job(job_id, status="content_ready", ready_for="publish", overall_progress=100, message="Remote media ready", source_metadata={"canonicalUrl": str(response.url), "filename": filename, "mimeType": content_type}, stages=jobs.completed_stages("direct"), metrics={"downloadedBytes": transferred, "totalBytes": total or transferred})
    except Exception as exc:
        if part:
            part.unlink(missing_ok=True)
        await jobs._fail(job_id, exc)


async def _run_fediverse(job_id: str, cancel: threading.Event) -> None:
    pending_tokens: set[str] = set()
    try:
        job = await jobs.get_job(job_id)
        if not job:
            return
        await jobs.update_job(job_id, status="downloading", operation="fediverse", ready_for=None, stages=jobs._stages("fediverse"), overall_progress=0, message="Resolving Fediverse post", error=None, cancel_requested=False)
        await jobs.set_progress(job_id, "fediverse", "resolve", 5, "Resolving Fediverse post")
        from ..routers import uploads

        async with jobs._network_slots:
            result = await uploads._upload_from_fediverse_impl(uploads.FediverseRequest(url=job.source_url or ""))
        if cancel.is_set():
            raise jobs.JobCancelled()
        imported = result.get("uploads") or []
        pending_tokens = {item.get("token") for item in imported if item.get("token")}
        await jobs.set_progress(job_id, "fediverse", "attachments", 30, f"Found {len(imported)} attachment(s)")
        directory = jobs._job_dir(job_id)
        for index, item in enumerate(imported, start=1):
            token = item.get("token")
            source_path = uploads.get_upload_path(token)
            if not source_path or not source_path.exists():
                raise jobs.JobError("attachment_missing", "A resolved Fediverse attachment was unavailable.", retryable=True)
            extension = jobs._media_extension(item.get("filename"), mimetypes.guess_type(source_path.name)[0])
            final = directory / f"source-{index}{extension}"
            source_path.replace(final)
            uploads.remove_upload_token(token)
            pending_tokens.discard(token)
            await jobs.set_progress(job_id, "fediverse", "download", 30 + int(index / len(imported) * 55), f"Downloaded attachment {index} of {len(imported)}")
            await _register_artifact(job_id, "source", final, Path(item.get("filename") or final.name).name, {"mimeType": mimetypes.guess_type(final.name)[0], "attachmentIndex": index})
        await jobs.set_progress(job_id, "fediverse", "register", 95, "Registering Fediverse media")
        await jobs.update_job(job_id, status="content_ready", ready_for="publish", overall_progress=100, message=f"{len(imported)} attachment(s) ready", source_metadata={"canonicalUrl": result.get("source") or job.source_url, "tags": result.get("tags") or [], "title": result.get("title"), "platform": result.get("platform")}, stages=jobs.completed_stages("fediverse"), metrics={"attachmentCount": len(imported)})
    except Exception as exc:
        await jobs._fail(job_id, exc)
    finally:
        if pending_tokens:
            from ..routers import uploads

            for token in pending_tokens:
                source_path = uploads.get_upload_path(token)
                if source_path:
                    source_path.unlink(missing_ok=True)
                uploads.remove_upload_token(token)


def _safe_title(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 _-]+", "", value or "video").strip()
    return re.sub(r"\s+", "_", cleaned)[:80] or "video"


def x_video_filter(landscape: bool) -> str:
    max_width, max_height = (1280, 720) if landscape else (720, 1280)
    return (
        f"scale=w='min(iw,{max_width})':h='min(ih,{max_height})':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2,"
        "pad=w='max(iw,ceil(ih/3/2)*2)':h='max(ih,ceil(iw/3/2)*2)':"
        "x='(ow-iw)/2':y='(oh-ih)/2':color=black,fps=30,setsar=1,format=yuv420p"
    )


def _download_section(
    url: str,
    dest_dir: Path,
    prefix: str,
    start_seconds: float,
    end_seconds: float,
    max_height: int,
    cancel: threading.Event,
    progress,
) -> Path:
    try:
        import yt_dlp
    except ImportError as exc:
        raise jobs.JobError("ytdlp_missing", "yt-dlp is not installed.") from exc
    for old in dest_dir.glob(f"{prefix}*"):
        if old.is_file():
            old.unlink(missing_ok=True)

    last_emit = 0.0

    def hook(data):
        nonlocal last_emit
        if cancel.is_set():
            raise jobs.JobCancelled()
        now = time.monotonic()
        if data.get("status") == "downloading" and now - last_emit >= 0.2:
            last_emit = now
            downloaded = int(data.get("downloaded_bytes") or 0)
            total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
            percent = int(downloaded / total * 100) if total else 1
            progress(percent, {
                "downloadedBytes": downloaded,
                "totalBytes": total or None,
                "speedBytesPerSec": data.get("speed"),
                "etaSeconds": data.get("eta"),
            })

    opts = {
        "format": f"bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/best",
        "outtmpl": str(dest_dir / f"{prefix}.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "merge_output_format": "mp4",
        "force_keyframes_at_cuts": True,
        "download_ranges": lambda _info, _ydl: [{"start_time": start_seconds, "end_time": end_seconds}],
        "progress_hooks": [hook],
        "socket_timeout": 30,
        "retries": 2,
    }
    cookiefile = jobs._cookie_file()
    if cookiefile:
        opts["cookiefile"] = cookiefile
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except jobs.JobCancelled:
        raise
    except Exception as exc:
        raise jobs.JobError("range_download_failed", f"Could not download the selected range: {exc}", retryable=True, remediation="Update yt-dlp or configure cookies in Settings.") from exc
    candidates = [path for path in dest_dir.glob(f"{prefix}.*") if path.is_file() and path.suffix not in {".part", ".ytdl"}]
    if not candidates:
        raise jobs.JobError("range_download_missing", "The range download finished without a media file.", retryable=True)
    result = max(candidates, key=lambda item: item.stat().st_size)
    downloaded_info = get_video_info(result)
    downloaded_duration = float(downloaded_info.get("duration") or 0)
    requested_duration = end_seconds - start_seconds
    if downloaded_duration <= 0 or downloaded_duration > requested_duration + 2:
        result.unlink(missing_ok=True)
        raise jobs.JobError(
            "range_sampling_unsupported",
            "This source does not support bounded range sampling.",
            remediation="Download a short source manually and upload it as a local file.",
        )
    if result.stat().st_size > 1024 * 1024 * 1024:
        result.unlink(missing_ok=True)
        raise jobs.JobError("range_too_large", "The selected range exceeded the 1 GB processing limit.")
    return result


def _run_ffmpeg(cmd: list[str], duration: float, cancel: threading.Event, progress) -> None:
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    output: list[str] = []
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            output.append(line)
            if len(output) > 200:
                output.pop(0)
            if cancel.is_set():
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                raise jobs.JobCancelled()
            key, _, value = line.strip().partition("=")
            if key in {"out_time_ms", "out_time_us"} and duration > 0:
                try:
                    seconds = int(value) / 1_000_000
                    progress(min(99, int(seconds / duration * 100)), {"processedMs": round(seconds * 1000), "totalMs": round(duration * 1000)})
                except ValueError:
                    pass
        code = proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
    if code != 0:
        raise jobs.JobError("ffmpeg_failed", "FFmpeg could not process the selected clip.", retryable=True, remediation="Review the backend log and media-tool diagnostics.")


def _ffmpeg_progress_bridge(loop, job_id, operation, stage, base, span):
    last = {"value": -1}

    def emit(percent: int, metrics: dict):
        overall = base + int(max(0, min(100, percent)) / 100 * span)
        if overall <= last["value"]:
            return
        last["value"] = overall
        if stage in {"pass1", "pass2"}:
            metrics = {**metrics, "encodingPass": 1 if stage == "pass1" else 2}
        asyncio.run_coroutine_threadsafe(jobs.set_progress(job_id, operation, stage, overall, f"{stage.replace('_', ' ').title()} {percent}%", metrics=metrics), loop)

    return emit


async def _remove_artifacts(job_id: str, roles: set[str]) -> None:
    async with async_session() as session:
        result = await session.execute(select(UploadArtifact).where(UploadArtifact.job_id == job_id, UploadArtifact.role.in_(roles)))
        for artifact in result.scalars().all():
            jobs.artifact_path(artifact).unlink(missing_ok=True)
            await session.delete(artifact)
        await session.commit()


async def _register_artifact(job_id: str, role: str, path: Path, filename: str, metadata: dict) -> UploadArtifact:
    root = settings.cache_dir.resolve()
    relative = str(path.resolve().relative_to(root)).replace("\\", "/")
    expires = datetime.utcnow() + jobs.JOB_TTL
    digest = sha256_file(path)

    async with async_session() as session:
        artifact = UploadArtifact(
            job_id=job_id,
            role=role,
            relative_path=relative,
            filename=filename,
            mime_type=metadata.get("mimeType") or ("image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else mimetypes.guess_type(path.name)[0] or "application/octet-stream"),
            file_size=path.stat().st_size,
            sha256=digest,
            width=metadata.get("width"),
            height=metadata.get("height"),
            duration=metadata.get("duration"),
            metadata_json=jobs._dumps(metadata),
            expires_at=expires,
        )
        session.add(artifact)
        await session.commit()
        await session.refresh(artifact)
        return artifact


def sha256_file(path: Path) -> str:
    digest_hash = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest_hash.update(chunk)
    return digest_hash.hexdigest()


def _verify_video(path: Path, expected_duration: float, *, strict_x: bool = False) -> dict:
    info = get_video_info(path)
    duration = float(info.get("duration") or 0)
    if not info.get("width") or not info.get("height") or duration <= 0:
        raise jobs.JobError("verification_failed", "Rendered clip has invalid video metadata.")
    if abs(duration - expected_duration) > max(0.05, 1 / max(float(info.get("frameRate") or 30), 1)):
        raise jobs.JobError("duration_mismatch", "Rendered duration does not match the reviewed selection.")
    if strict_x:
        width = int(info.get("width") or 0)
        height = int(info.get("height") or 0)
        frame_rate = float(info.get("frameRate") or 0)
        profile = str(info.get("profile") or "").lower()
        if info.get("codec") != "h264" or "high" not in profile:
            raise jobs.JobError("x_codec_mismatch", "Final video is not H.264 High Profile.")
        if info.get("pixelFormat") != "yuv420p" or info.get("fieldOrder") not in {"progressive", "unknown", None}:
            raise jobs.JobError("x_scan_mismatch", "Final video is not progressive YUV 4:2:0.")
        if width <= 0 or height <= 0 or width % 2 or height % 2 or abs(frame_rate - 30) > 0.01:
            raise jobs.JobError("x_dimensions_mismatch", "Final dimensions or frame rate are incompatible with X.")
        if (width >= height and (width > 1280 or height > 720)) or (height > width and (width > 720 or height > 1280)):
            raise jobs.JobError("x_dimensions_mismatch", "Final dimensions exceed the X standard preset.")
        ratio = width / height
        if ratio < 1 / 3 or ratio > 3:
            raise jobs.JobError("x_aspect_mismatch", "Final aspect ratio is outside X limits.")
        if info.get("audioCodec") not in {None, "aac"} or int(info.get("audioChannels") or 0) > 2:
            raise jobs.JobError("x_audio_mismatch", "Final audio is not AAC-LC mono/stereo.")
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=format_name:stream=codec_type,sample_aspect_ratio", "-of", "json", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        try:
            details = json.loads(probe.stdout) if probe.returncode == 0 else {}
        except json.JSONDecodeError:
            details = {}
        format_names = str(details.get("format", {}).get("format_name") or "").split(",")
        video_stream = next((stream for stream in details.get("streams", []) if stream.get("codec_type") == "video"), {})
        if "mp4" not in format_names or video_stream.get("sample_aspect_ratio") not in {"1:1", None}:
            raise jobs.JobError("x_container_mismatch", "Final media is not square-pixel MP4.")
    decode = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", os.devnull], capture_output=True, timeout=max(60, int(duration * 3)))
    if decode.returncode != 0:
        raise jobs.JobError("decode_failed", "Rendered clip failed the complete decode check.")
    if path.stat().st_size > min(settings.max_upload_size, 512 * 1024 * 1024):
        raise jobs.JobError("output_too_large", "Rendered clip exceeds the configured upload limit.")
    return info


async def request_sample(job_id: str, start_ms: int, end_ms: int, revision: int) -> dict:
    job = await jobs.get_job(job_id)
    if not job:
        raise jobs.JobError("job_not_found", "Upload job not found.")
    if revision != job.revision:
        raise jobs.JobError("stale_revision", "The editor changed; refresh before sampling again.")
    source = json.loads(job.source_metadata_json or "{}")
    start_ms, end_ms = jobs.validate_selection(start_ms, end_ms, source.get("duration") or 0)
    await _remove_artifacts(job_id, {"sample", "timeline", "waveform", "render"})
    await jobs.update_job(job_id, selection_start_ms=start_ms, selection_end_ms=end_ms, revision=job.revision + 1, status="awaiting_selection", ready_for=None)
    await jobs.launch(job_id, "sample")
    result = await jobs.snapshot(job_id)
    assert result is not None
    return result


async def _run_sample(job_id: str, cancel: threading.Event) -> None:
    try:
        job = await jobs.get_job(job_id)
        if not job:
            return
        source = json.loads(job.source_metadata_json or "{}")
        start_ms, end_ms = jobs.validate_selection(job.selection_start_ms, job.selection_end_ms, source.get("duration") or 0)
        context_start = max(0, start_ms - 5000)
        context_end = min(source["durationMs"], end_ms + 5000)
        duration = (context_end - context_start) / 1000
        loop = asyncio.get_running_loop()
        directory = jobs._job_dir(job_id)
        await jobs.update_job(job_id, status="sampling", operation="sample", ready_for=None, overall_progress=0, stages=jobs._stages("sample"), metrics={}, error=None, cancel_requested=False)
        await jobs.set_progress(job_id, "sample", "resolve", 5, "Resolving preview formats")
        await jobs.set_progress(job_id, "sample", "download", 10, "Downloading bounded preview range")
        async with jobs._network_slots:
            downloaded = await asyncio.to_thread(
                _download_section,
                job.source_url or "",
                directory,
                "sample-source",
                context_start / 1000,
                context_end / 1000,
                480,
                cancel,
                _ffmpeg_progress_bridge(loop, job_id, "sample", "download", 10, 45),
            )
        preview_part = directory / "sample.part.mp4"
        preview_path = directory / "sample.mp4"
        preview_part.unlink(missing_ok=True)
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-nostats", "-i", str(downloaded),
            "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", "-progress", "pipe:1", str(preview_part),
        ]
        async with jobs._transcode_slots:
            await asyncio.to_thread(_run_ffmpeg, cmd, duration, cancel, _ffmpeg_progress_bridge(loop, job_id, "sample", "proxy", 55, 20))
            timeline = directory / "timeline.jpg"
            await jobs.set_progress(job_id, "sample", "thumbnails", 75, "Generating timeline thumbnails")
            fps = max(0.01, 12 / max(duration, 0.5))
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(preview_part), "-vf", f"fps={fps},scale=160:-2,tile=12x1", "-frames:v", "1", str(timeline)], check=True, timeout=120)
            waveform = directory / "waveform.jpg"
            await jobs.set_progress(job_id, "sample", "waveform", 90, "Generating audio waveform")
            wave = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(preview_part), "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x160:colors=#6aadde", "-frames:v", "1", str(waveform)], capture_output=True, timeout=120)
            await jobs.set_progress(job_id, "sample", "verify", 95, "Verifying preview")
            info = _verify_video(preview_part, duration)
            preview_part.replace(preview_path)
        info.update({"contextStartMs": context_start, "contextEndMs": context_end, "selectionStartMs": start_ms, "selectionEndMs": end_ms})
        await _register_artifact(job_id, "sample", preview_path, "clip-preview.mp4", info)
        await _register_artifact(job_id, "timeline", timeline, "timeline.jpg", {})
        if wave.returncode == 0 and waveform.exists():
            await _register_artifact(job_id, "waveform", waveform, "waveform.jpg", {})
        downloaded.unlink(missing_ok=True)
        await jobs.update_job(job_id, status="sample_ready", ready_for="render", overall_progress=100, message="Preview ready", stages=jobs.completed_stages("sample"), metrics={})
    except Exception as exc:
        await jobs._fail(job_id, exc)


async def request_render(job_id: str, revision: int, profile: str) -> dict:
    job = await jobs.get_job(job_id)
    if not job:
        raise jobs.JobError("job_not_found", "Upload job not found.")
    if revision != job.revision:
        raise jobs.JobError("stale_revision", "The sampled selection changed; render the latest revision.")
    if job.status != "sample_ready":
        raise jobs.JobError("preview_required", "Review a sampled preview before rendering.")
    if profile != "x-standard":
        raise jobs.JobError("unsupported_profile", "Only the x-standard profile is available.")
    await _remove_artifacts(job_id, {"render"})
    await jobs.launch(job_id, "render")
    result = await jobs.snapshot(job_id)
    assert result is not None
    return result


async def _run_render(job_id: str, cancel: threading.Event) -> None:
    try:
        job = await jobs.get_job(job_id)
        if not job:
            return
        source = json.loads(job.source_metadata_json or "{}")
        start_ms, end_ms = jobs.validate_selection(job.selection_start_ms, job.selection_end_ms, source.get("duration") or 0)
        pad_start = max(0, start_ms - 3000)
        pad_end = min(source["durationMs"], end_ms + 3000)
        offset = (start_ms - pad_start) / 1000
        duration = (end_ms - start_ms) / 1000
        loop = asyncio.get_running_loop()
        directory = jobs._job_dir(job_id)
        await jobs.update_job(job_id, status="rendering", operation="render", ready_for=None, overall_progress=0, stages=jobs._stages("render"), metrics={}, error=None, cancel_requested=False)
        await jobs.set_progress(job_id, "render", "resolve", 3, "Resolving fresh source formats")
        await jobs.set_progress(job_id, "render", "download", 5, "Downloading bounded render range")
        async with jobs._network_slots:
            downloaded = await asyncio.to_thread(
                _download_section,
                job.source_url or "",
                directory,
                "render-source",
                pad_start / 1000,
                pad_end / 1000,
                1080,
                cancel,
                _ffmpeg_progress_bridge(loop, job_id, "render", "download", 5, 40),
            )
        landscape = int(source.get("width") or 16) >= int(source.get("height") or 9)
        vf = x_video_filter(landscape)
        passlog = directory / "x-pass"
        common = ["-ss", f"{offset:.3f}", "-t", f"{duration:.3f}", "-i", str(downloaded), "-map", "0:v:0", "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-b:v", "5000k", "-maxrate", "8000k", "-bufsize", "10000k", "-g", "90", "-keyint_min", "45", "-x264-params", "open-gop=0:scenecut=40", "-flags", "+cgop", "-passlogfile", str(passlog)]
        pass1 = ["ffmpeg", "-y", "-hide_banner", "-nostats", *common, "-an", "-pass", "1", "-f", "mp4", "-progress", "pipe:1", os.devnull]
        async with jobs._transcode_slots:
            await asyncio.to_thread(_run_ffmpeg, pass1, duration, cancel, _ffmpeg_progress_bridge(loop, job_id, "render", "pass1", 45, 20))
            final_part = directory / "final.part.mp4"
            final_path = directory / "final.mp4"
            final_part.unlink(missing_ok=True)
            pass2 = ["ffmpeg", "-y", "-hide_banner", "-nostats", *common, "-map", "0:a:0?", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ac", "2", "-pass", "2", "-movflags", "+faststart", "-progress", "pipe:1", str(final_part)]
            await asyncio.to_thread(_run_ffmpeg, pass2, duration, cancel, _ffmpeg_progress_bridge(loop, job_id, "render", "pass2", 65, 25))
            await jobs.set_progress(job_id, "render", "verify", 92, "Verifying final clip")
            info = _verify_video(final_part, duration, strict_x=True)
            final_part.replace(final_path)
        await jobs.set_progress(job_id, "render", "register", 98, "Registering reviewed artifact")
        title = _safe_title(source.get("title") or "video")
        def filename_time(milliseconds: int) -> str:
            seconds = milliseconds // 1000
            hours, seconds = divmod(seconds, 3600)
            minutes, seconds = divmod(seconds, 60)
            prefix = f"{hours}h" if hours else ""
            return f"{prefix}{minutes}m{seconds:02d}s"

        filename = f"{title}_{filename_time(start_ms)}-{filename_time(end_ms)}.mp4"
        info.update({"profile": "x-standard", "selectionStartMs": start_ms, "selectionEndMs": end_ms, "xCompatible": True})
        await _register_artifact(job_id, "render", final_path, filename, info)
        downloaded.unlink(missing_ok=True)
        for log in directory.glob("x-pass*"):
            log.unlink(missing_ok=True)
        await jobs.update_job(job_id, status="render_ready", ready_for="publish", overall_progress=100, message="Final clip ready for review", stages=jobs.completed_stages("render"), metrics={})
    except Exception as exc:
        await jobs._fail(job_id, exc)
