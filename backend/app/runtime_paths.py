"""Package-aware runtime path resolution for NekoBooru."""
from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass
from pathlib import Path


APP_DIR_NAME = "NekoBooru"
XDG_NAME = "nekobooru"


@dataclass(frozen=True)
class RuntimePaths:
    app_dir: Path
    bundle_dir: Path
    config_dir: Path
    config_file: Path
    data_dir: Path
    logs_dir: Path
    cache_dir: Path
    models_dir: Path
    runtimes_dir: Path
    ai_venv_dir: Path
    packaged: bool
    portable: bool


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name)
    if not value:
        return None
    return Path(value).expanduser().resolve()


def app_dir() -> Path:
    override = _env_path("NEKO_APP_DIR")
    if override:
        return override
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def bundle_dir() -> Path:
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)).resolve()
    return Path(__file__).resolve().parents[2]


def _windows_user_root() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if base:
        return Path(base) / APP_DIR_NAME
    return Path.home() / "AppData" / "Local" / APP_DIR_NAME


def _xdg_path(env_name: str, fallback: Path) -> Path:
    raw = os.environ.get(env_name)
    return Path(raw).expanduser() if raw else fallback


def _default_roots(packaged: bool, portable: bool, root: Path) -> dict[str, Path]:
    if portable or not packaged:
        return {
            "config": root / "config",
            "data": root / "data",
            "logs": root / "logs",
            "cache": root / "data" / "cache",
            "models": root / "models",
            "runtimes": root / "runtimes",
        }

    if platform.system().lower() == "windows":
        user_root = _windows_user_root()
        data_root = user_root / "data"
        return {
            "config": user_root / "config",
            "data": data_root,
            "logs": user_root / "logs",
            "cache": data_root / "cache",
            "models": user_root / "models",
            "runtimes": user_root / "runtimes",
        }

    config_root = _xdg_path("XDG_CONFIG_HOME", Path.home() / ".config") / XDG_NAME
    data_root = _xdg_path("XDG_DATA_HOME", Path.home() / ".local" / "share") / XDG_NAME
    cache_root = _xdg_path("XDG_CACHE_HOME", Path.home() / ".cache") / XDG_NAME
    state_root = _xdg_path("XDG_STATE_HOME", Path.home() / ".local" / "state") / XDG_NAME
    return {
        "config": config_root,
        "data": data_root,
        "logs": state_root / "logs",
        "cache": cache_root,
        "models": data_root / "models",
        "runtimes": data_root / "runtimes",
    }


def get_runtime_paths() -> RuntimePaths:
    root = app_dir()
    packaged = is_frozen() or _truthy(os.environ.get("NEKO_PACKAGED"))
    portable = _truthy(os.environ.get("NEKO_PORTABLE"))
    roots = _default_roots(packaged=packaged, portable=portable, root=root)

    config_dir = _env_path("NEKO_CONFIG_DIR") or roots["config"]
    data_dir = _env_path("NEKO_DATA_DIR") or roots["data"]
    logs_dir = _env_path("NEKO_LOGS_DIR") or roots["logs"]
    cache_dir = _env_path("NEKO_CACHE_DIR") or roots["cache"]
    models_dir = _env_path("NEKO_MODELS_DIR") or roots["models"]
    runtimes_dir = _env_path("NEKO_RUNTIMES_DIR") or roots["runtimes"]
    ai_venv_dir = _env_path("NEKO_AI_VENV") or (runtimes_dir / "python-ai")
    config_file = _env_path("NEKO_CONFIG_FILE") or (config_dir / "settings.json")

    return RuntimePaths(
        app_dir=root,
        bundle_dir=bundle_dir(),
        config_dir=config_dir.resolve(),
        config_file=config_file.resolve(),
        data_dir=data_dir.resolve(),
        logs_dir=logs_dir.resolve(),
        cache_dir=cache_dir.resolve(),
        models_dir=models_dir.resolve(),
        runtimes_dir=runtimes_dir.resolve(),
        ai_venv_dir=ai_venv_dir.resolve(),
        packaged=packaged,
        portable=portable,
    )


runtime_paths = get_runtime_paths()
