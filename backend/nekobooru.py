#!/usr/bin/env python
"""NekoBooru standalone entry point for PyInstaller builds."""

import atexit
import json
import os
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen
import uvicorn
from app.ai_runtime_link import link_ai_runtime

link_ai_runtime()

from app.config import settings
from app.main import app
from app.runtime_paths import runtime_paths

_INSTANCE_LOCK_FILE = None
_AI_WORKER_PROCESS = None


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


def start_packaged_ai_worker() -> None:
    """Start the managed local AI worker for packaged local-AI installs."""
    global _AI_WORKER_PROCESS
    if not runtime_paths.packaged or os.environ.get("NEKO_AI_WORKER"):
        return
    installer = _settings_section("installer")
    if installer.get("aiProfile") not in {"cpu", "gpu-cu128", "gpu-cu126-legacy"}:
        return
    worker_port = int(settings.port) + 1
    if _health_ok(worker_port):
        return
    worker_python = runtime_paths.ai_venv_dir / "Scripts" / "python.exe" if os.name == "nt" else runtime_paths.ai_venv_dir / "bin" / "python"
    worker_script = runtime_paths.app_dir / "worker-backend" / "run_prod.py"
    if not worker_python.exists() or not worker_script.exists():
        return

    runtime_paths.logs_dir.mkdir(parents=True, exist_ok=True)
    out_log = open(runtime_paths.logs_dir / "local-ai-worker.out.log", "a", encoding="utf-8")
    err_log = open(runtime_paths.logs_dir / "local-ai-worker.err.log", "a", encoding="utf-8")
    env = _worker_base_env()
    env.update(
        {
        "NEKO_AI_WORKER": "1",
        "NEKO_PACKAGED": "1",
        "NEKO_APP_DIR": str(runtime_paths.app_dir),
        "NEKO_HOST": "127.0.0.1",
        "NEKO_PORT": str(worker_port),
        "NEKO_CONFIG_DIR": str(runtime_paths.config_dir),
        "NEKO_DATA_DIR": str(runtime_paths.data_dir),
        "NEKO_LOGS_DIR": str(runtime_paths.logs_dir),
        "NEKO_MODELS_DIR": str(runtime_paths.models_dir),
        "NEKO_RUNTIMES_DIR": str(runtime_paths.runtimes_dir),
        "NEKO_AI_VENV": str(runtime_paths.ai_venv_dir),
        "NEKO_CACHE_DIR": str(runtime_paths.cache_dir),
        "PYTHONNOUSERSITE": "1",
        }
    )
    if os.name == "nt":
        env["VIRTUAL_ENV"] = str(runtime_paths.ai_venv_dir)
        env["PATH"] = os.pathsep.join(
            [
                str(runtime_paths.ai_venv_dir / "Scripts"),
                str(runtime_paths.ai_venv_dir),
                env.get("PATH", ""),
            ]
        )
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        dll_reset = _temporarily_reset_windows_dll_directory()
        _AI_WORKER_PROCESS = subprocess.Popen(
            [str(worker_python), str(worker_script)],
            cwd=str(worker_script.parent),
            env=env,
            stdout=out_log,
            stderr=err_log,
            creationflags=creationflags,
        )
        atexit.register(stop_packaged_ai_worker)
        for _ in range(20):
            if _health_ok(worker_port):
                break
            time.sleep(0.25)
    except OSError as exc:
        print(f"Could not start local AI worker: {exc}")
    finally:
        if os.name == "nt":
            _restore_windows_dll_directory(dll_reset)


def _worker_base_env() -> dict[str, str]:
    """Return a minimal environment so the venv worker avoids PyInstaller DLLs."""
    keys = [
        "ALLUSERSPROFILE",
        "APPDATA",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
        "WINDIR",
    ]
    env = {key: value for key in keys if (value := os.environ.get(key))}
    if os.name == "nt":
        system_root = env.get("SYSTEMROOT") or r"C:\Windows"
        env["PATH"] = os.pathsep.join(
            [
                os.path.join(system_root, "System32"),
                os.path.join(system_root, "System32", "Wbem"),
                os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0"),
                system_root,
            ]
        )
    else:
        env["PATH"] = os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
        for key in ("HOME", "LANG", "LC_ALL", "SHELL", "USER"):
            if value := os.environ.get(key):
                env[key] = value
    return env


def _temporarily_reset_windows_dll_directory():
    if os.name != "nt":
        return None
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
        kernel32.SetDllDirectoryW.restype = ctypes.c_bool
        kernel32.SetDllDirectoryW(None)
        return kernel32
    except Exception:
        return None


def _restore_windows_dll_directory(kernel32) -> None:
    if os.name != "nt" or kernel32 is None:
        return
    try:
        bundle_dir = str(runtime_paths.bundle_dir)
        kernel32.SetDllDirectoryW(bundle_dir)
    except Exception:
        pass


def stop_packaged_ai_worker() -> None:
    global _AI_WORKER_PROCESS
    if not _AI_WORKER_PROCESS:
        return
    if _AI_WORKER_PROCESS.poll() is None:
        _AI_WORKER_PROCESS.terminate()
    _AI_WORKER_PROCESS = None


def _settings_section(name: str) -> dict:
    try:
        with open(runtime_paths.config_file, "r", encoding="utf-8-sig") as handle:
            value = json.load(handle).get(name) or {}
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _health_ok(port: int) -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload.get("status") == "ok" and payload.get("service") == settings.app_name
    except (OSError, URLError, TimeoutError, json.JSONDecodeError):
        return False


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

    start_packaged_ai_worker()

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
