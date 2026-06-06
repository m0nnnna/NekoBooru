"""Runtime yt-dlp version and update management."""
from __future__ import annotations

import asyncio
import importlib
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from ..config import settings
from .settings import SettingsManager


VALID_POLICIES = {"manual", "startup_latest", "startup_pinned"}


@dataclass
class YtdlpUpdateJob:
    status: str = "idle"
    target: str = "latest"
    started_at: str | None = None
    finished_at: str | None = None
    before_version: str | None = None
    after_version: str | None = None
    error: str | None = None
    output: str = ""


_job = YtdlpUpdateJob()
_lock = asyncio.Lock()


def display_path(raw_path: str) -> str:
    if not raw_path:
        return ""
    try:
        path = Path(raw_path).resolve()
        base = settings.base_dir.resolve()
        return str(path.relative_to(base))
    except Exception:
        return raw_path


def load_settings() -> dict:
    raw = SettingsManager(settings.config_file).get_ytdlp_settings()
    policy = raw.get("updatePolicy") or raw.get("update_policy") or "manual"
    if policy not in VALID_POLICIES:
        policy = "manual"
    return {
        "updatePolicy": policy,
        "pinnedVersion": str(raw.get("pinnedVersion") or raw.get("pinned_version") or "").strip(),
    }


def save_settings(raw: dict) -> dict:
    policy = raw.get("updatePolicy") or "manual"
    if policy not in VALID_POLICIES:
        policy = "manual"
    cleaned = {
        "updatePolicy": policy,
        "pinnedVersion": str(raw.get("pinnedVersion") or "").strip(),
    }
    SettingsManager(settings.config_file).set_ytdlp_settings(cleaned)
    return cleaned


def installed_info() -> dict:
    try:
        import yt_dlp

        return {
            "installed": True,
            "version": getattr(yt_dlp.version, "__version__", "unknown"),
            "path": getattr(yt_dlp, "__file__", ""),
            "pathDisplay": display_path(getattr(yt_dlp, "__file__", "")),
            "python": sys.executable,
            "pythonDisplay": display_path(sys.executable),
        }
    except Exception as exc:
        return {
            "installed": False,
            "version": None,
            "path": "",
            "pathDisplay": "",
            "python": sys.executable,
            "pythonDisplay": display_path(sys.executable),
            "error": str(exc),
        }


def status() -> dict:
    return {
        **installed_info(),
        **load_settings(),
        "job": asdict(_job),
    }


async def maybe_update_on_startup() -> None:
    cfg = load_settings()
    if cfg["updatePolicy"] == "manual":
        return
    if cfg["updatePolicy"] == "startup_pinned" and not cfg["pinnedVersion"]:
        return
    target = cfg["pinnedVersion"] if cfg["updatePolicy"] == "startup_pinned" else "latest"
    await start_update(target)


async def start_update(target: str = "latest") -> dict:
    if target != "latest":
        target = str(target or "").strip()
        if not target:
            raise ValueError("Pinned yt-dlp version is required")
    async with _lock:
        if _job.status in {"queued", "running"}:
            return asdict(_job)
        _job.status = "queued"
        _job.target = target
        _job.started_at = None
        _job.finished_at = None
        _job.before_version = installed_info().get("version")
        _job.after_version = None
        _job.error = None
        _job.output = ""
        asyncio.create_task(_run_update(target))
        return asdict(_job)


async def _run_update(target: str) -> None:
    _job.status = "running"
    _job.started_at = datetime.utcnow().isoformat()
    package = "yt-dlp" if target == "latest" else f"yt-dlp=={target}"
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", package]
    if target == "latest":
        cmd.extend(["--upgrade-strategy", "eager"])
    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            check=False,
        )
        _job.output = (proc.stdout or "")[-12000:]
        if proc.returncode != 0:
            _job.status = "failed"
            _job.error = f"pip exited with code {proc.returncode}"
            return

        importlib.invalidate_caches()
        try:
            import yt_dlp

            importlib.reload(yt_dlp.version)
            importlib.reload(yt_dlp)
        except Exception:
            pass
        _job.after_version = installed_info().get("version")
        _job.status = "completed"
    except Exception as exc:
        _job.status = "failed"
        _job.error = str(exc)
    finally:
        _job.finished_at = datetime.utcnow().isoformat()
