#!/usr/bin/env python
"""NekoBooru standalone entry point for PyInstaller builds."""

import atexit
import json
import os
import sys
from urllib.error import URLError
from urllib.request import urlopen
import uvicorn
from app.ai_runtime_link import link_ai_runtime

link_ai_runtime()

from app.config import settings
from app.main import app
from app.runtime_paths import runtime_paths

_INSTANCE_LOCK_FILE = None


def existing_instance_is_running() -> bool:
    if not runtime_paths.packaged:
        return False
    try:
        with urlopen(f"http://{settings.host}:{settings.port}/api/health", timeout=1.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload.get("status") == "ok" and payload.get("service") == settings.app_name
    except (OSError, URLError, TimeoutError, json.JSONDecodeError):
        return False


def acquire_packaged_instance_lock() -> bool:
    """Prevent duplicate installed/packaged app instances.

    Source/dev mode intentionally does not use this lock so developers can run
    dev servers while testing a packaged install on another port.
    """
    global _INSTANCE_LOCK_FILE
    if not runtime_paths.packaged:
        return True

    runtime_paths.config_dir.mkdir(parents=True, exist_ok=True)
    lock_path = runtime_paths.config_dir / "nekobooru-instance.lock"
    lock_file = open(lock_path, "a+b")

    if os.name == "nt":
        import msvcrt

        try:
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            lock_file.close()
            return False
    else:
        import fcntl

        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lock_file.close()
            return False

    _INSTANCE_LOCK_FILE = lock_file
    atexit.register(release_packaged_instance_lock)
    return True


def release_packaged_instance_lock():
    global _INSTANCE_LOCK_FILE
    if not _INSTANCE_LOCK_FILE:
        return
    try:
        if os.name == "nt":
            import msvcrt

            _INSTANCE_LOCK_FILE.seek(0)
            msvcrt.locking(_INSTANCE_LOCK_FILE.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(_INSTANCE_LOCK_FILE.fileno(), fcntl.LOCK_UN)
    finally:
        _INSTANCE_LOCK_FILE.close()
        _INSTANCE_LOCK_FILE = None


def main():
    if existing_instance_is_running():
        print(
            f"{settings.app_name} is already running at "
            f"http://localhost:{settings.port}."
        )
        return 0

    if not acquire_packaged_instance_lock():
        print(
            f"{settings.app_name} is already running as an installed app. "
            f"Open http://localhost:{settings.port} or close the existing instance first."
        )
        return 0

    print(f"\n{'='*50}")
    print(f"  {settings.app_name}")
    print(f"{'='*50}")
    print(f"  URL: http://localhost:{settings.port}")
    print(f"  API Docs: http://localhost:{settings.port}/docs")
    print(f"  Database: {settings.database_path}")
    print(f"  Data Dir: {settings.data_dir}")
    print(f"{'='*50}\n")

    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
