"""Safe conversion of Pixiv ugoira frame archives into playable MP4 files."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import urlparse


MAX_FRAME_COUNT = 2000
MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
_FRAME_NAME = re.compile(r"^[^\\/]+\.(?:jpe?g|png)$", re.IGNORECASE)


def validate_pixiv_ugoira_url(raw: str) -> str:
    """Return a trusted Pixiv CDN ZIP URL or raise ``ValueError``."""
    parsed = urlparse(str(raw or "").strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or (host != "pximg.net" and not host.endswith(".pximg.net")):
        raise ValueError("Pixiv animation URL must use the Pixiv image CDN")
    if not parsed.path.lower().endswith(".zip"):
        raise ValueError("Pixiv animation URL must point to the original frame ZIP")
    return parsed.geturl()


def normalize_frames(frames: list[dict]) -> list[dict]:
    if not frames or len(frames) > MAX_FRAME_COUNT:
        raise ValueError("Pixiv animation has an invalid frame count")
    normalized: list[dict] = []
    seen: set[str] = set()
    for frame in frames:
        name = str(frame.get("file") or "")
        try:
            delay = int(frame.get("delay"))
        except (TypeError, ValueError):
            raise ValueError("Pixiv animation has an invalid frame delay") from None
        if not _FRAME_NAME.fullmatch(name) or name in seen:
            raise ValueError("Pixiv animation has an invalid frame filename")
        if delay < 1 or delay > 60_000:
            raise ValueError("Pixiv animation has an invalid frame delay")
        seen.add(name)
        normalized.append({"file": name, "delay": delay})
    return normalized


def convert_ugoira_zip_to_mp4(archive_path: Path, frames: list[dict], destination: Path) -> None:
    """Extract only declared frames and encode their exact delays as H.264 MP4."""
    normalized = normalize_frames(frames)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="nekobooru-ugoira-") as temp_raw:
        temp_dir = Path(temp_raw)
        with zipfile.ZipFile(archive_path) as archive:
            members = {member.filename: member for member in archive.infolist()}
            selected = []
            total_size = 0
            for frame in normalized:
                member = members.get(frame["file"])
                if member is None or member.is_dir():
                    raise ValueError(f"Pixiv animation frame is missing: {frame['file']}")
                total_size += member.file_size
                if total_size > MAX_UNCOMPRESSED_BYTES:
                    raise ValueError("Pixiv animation is too large to convert safely")
                selected.append((frame, member))

            for frame, member in selected:
                target = temp_dir / frame["file"]
                with archive.open(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)

        concat_path = temp_dir / "frames.ffconcat"
        lines = ["ffconcat version 1.0"]
        for frame in normalized:
            lines.append(f"file '{frame['file']}'")
            lines.append(f"duration {frame['delay'] / 1000:.6f}")
        # The concat demuxer ignores the last duration without a repeated file.
        lines.append(f"file '{normalized[-1]['file']}'")
        concat_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        command = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", concat_path.name,
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-fps_mode", "vfr", "-an", "-c:v", "libx264", "-preset", "medium",
            "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(destination),
        ]
        options = {"cwd": temp_dir, "capture_output": True, "timeout": 900}
        if sys.platform == "win32":
            options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            result = subprocess.run(command, **options)
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            destination.unlink(missing_ok=True)
            raise RuntimeError("FFmpeg could not convert the Pixiv animation") from exc
        if result.returncode != 0 or not destination.is_file() or destination.stat().st_size == 0:
            destination.unlink(missing_ok=True)
            detail = result.stderr.decode("utf-8", errors="replace").strip()[-500:]
            raise RuntimeError(f"FFmpeg could not convert the Pixiv animation{': ' + detail if detail else ''}")

