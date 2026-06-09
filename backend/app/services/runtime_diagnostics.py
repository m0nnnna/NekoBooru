"""Runtime diagnostics used by Settings, installers, and native host repair."""
from __future__ import annotations

import importlib.metadata
import platform
import shutil
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path

from ..config import settings
from ..runtime_paths import runtime_paths
from .app_restart import restart_status
from . import ytdlp_manager


APP_VERSION = "4.1.0"


def _version(package: str) -> str | None:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def _tool_version(command: str, args: list[str]) -> dict:
    path = shutil.which(command)
    if not path:
        return {"available": False, "path": "", "version": None}
    version = None
    try:
        proc = subprocess.run(
            [path, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=5,
            check=False,
        )
        version = (proc.stdout or "").splitlines()[0] if proc.stdout else None
    except Exception as exc:  # noqa: BLE001
        version = f"error: {exc}"
    return {"available": True, "path": path, "version": version}


def _ai_python() -> Path:
    if platform.system().lower() == "windows":
        return runtime_paths.ai_venv_dir / "Scripts" / "python.exe"
    return runtime_paths.ai_venv_dir / "bin" / "python"


def _ai_receipt() -> dict | None:
    receipt = runtime_paths.ai_venv_dir / "nekobooru-ai-runtime.json"
    if not receipt.exists():
        return None
    try:
        import json

        return json.loads(receipt.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def _native_host_status() -> dict:
    system = platform.system().lower()
    name = "com.nekobooru.launcher.json"
    if system == "windows":
        local = Path.home() / "AppData" / "Local" / "NekoBooru" / "native-messaging-hosts"
        manifest = local / name
        return {
            "installed": manifest.exists(),
            "brave": manifest.exists(),
            "chrome": manifest.exists(),
            "chromium": manifest.exists(),
            "firefox": False,
            "manifestPath": str(manifest) if manifest.exists() else "",
        }

    xdg_config = Path.home() / ".config"
    manifests = {
        "chrome": xdg_config / "google-chrome" / "NativeMessagingHosts" / name,
        "chromium": xdg_config / "chromium" / "NativeMessagingHosts" / name,
        "brave": xdg_config / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts" / name,
        "edge": xdg_config / "microsoft-edge" / "NativeMessagingHosts" / name,
        "firefox": Path.home() / ".mozilla" / "native-messaging-hosts" / name,
    }
    installed = any(path.exists() for path in manifests.values())
    first = next((path for path in manifests.values() if path.exists()), None)
    return {
        "installed": installed,
        **{key: path.exists() for key, path in manifests.items()},
        "manifestPath": str(first) if first else "",
    }


def _model_counts() -> dict:
    try:
        from .auto_tagger import model_statuses

        models = model_statuses()
        return {
            "modelsDownloaded": len([m for m in models if m.get("downloaded")]),
            "modelsLoaded": len([m for m in models if m.get("loaded")]),
            "modelsTotal": len(models),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "modelsDownloaded": 0,
            "modelsLoaded": 0,
            "modelsTotal": 0,
            "modelStatusError": str(exc),
        }


def runtime_status() -> dict:
    ai_python = _ai_python()
    ai_receipt = _ai_receipt()
    model_counts = _model_counts()
    ai_mode = "local"
    try:
        from .auto_tagger import load_options

        opts = load_options()
        ai_mode = "remote" if opts.remoteEnabled else ("local" if opts.enabled else "disabled")
    except Exception:
        pass
    torch_version = _version("torch")
    onnx_version = _version("onnxruntime") or _version("onnxruntime-gpu")
    ytdlp = ytdlp_manager.status()

    return {
        "app": {
            "version": APP_VERSION,
            "packaged": runtime_paths.packaged,
            "portable": runtime_paths.portable,
            "platform": platform.system().lower(),
            "appDir": str(runtime_paths.app_dir),
            "bundleDir": str(runtime_paths.bundle_dir),
            "backendPort": settings.port,
            "frontendPort": settings.frontend_port,
        },
        "paths": {
            "configDir": str(settings.config_dir),
            "configFile": str(settings.config_file),
            "dataDir": str(settings.data_dir),
            "logsDir": str(settings.logs_dir),
            "cacheDir": str(settings.cache_dir),
            "modelsDir": str(settings.models_dir),
            "runtimesDir": str(settings.runtimes_dir),
            "aiVenv": str(settings.ai_venv_dir),
        },
        "python": {
            "coreExecutable": sys.executable,
            "aiExecutable": str(ai_python),
            "aiVenvExists": ai_python.exists(),
        },
        "tools": {
            "ffmpeg": _tool_version("ffmpeg", ["-version"]),
            "ffprobe": _tool_version("ffprobe", ["-version"]),
            "ytdlp": {
                "available": bool(ytdlp.get("installed")),
                "version": ytdlp.get("version"),
                "path": ytdlp.get("path"),
                "pinned": bool(ytdlp.get("pinnedVersion")),
                "updatePolicy": ytdlp.get("updatePolicy"),
            },
        },
        "ai": {
            "mode": ai_mode,
            "runtimeInstalled": bool(ai_receipt and not ai_receipt.get("error")),
            "profile": (ai_receipt or {}).get("profile"),
            "receipt": ai_receipt,
            "torch": {
                "available": find_spec("torch") is not None,
                "version": torch_version,
            },
            "onnx": {
                "available": find_spec("onnxruntime") is not None,
                "version": onnx_version,
            },
            **model_counts,
        },
        "nativeHost": _native_host_status(),
        "restart": restart_status(),
    }
