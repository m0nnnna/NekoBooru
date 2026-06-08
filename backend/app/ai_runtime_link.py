"""Link the optional managed AI runtime into the current Python process."""
from __future__ import annotations

import os
import site
import sys
from pathlib import Path

from .runtime_paths import runtime_paths


_LINKED = False


def link_ai_runtime() -> bool:
    """Expose packages installed into the managed AI venv to packaged builds.

    PyInstaller keeps the base app small by excluding torch/transformers/etc.
    When the installer or Settings creates the managed AI venv, those packages
    live outside the frozen bundle and must be placed on sys.path before lazy
    imports in auto_tagger run.
    """
    global _LINKED
    if _LINKED:
        return True

    venv = runtime_paths.ai_venv_dir
    site_packages = _site_packages_dir(venv)
    if not site_packages.exists():
        return False

    site.addsitedir(str(site_packages))
    _add_windows_dll_dirs(venv, site_packages)
    _LINKED = True
    return True


def _site_packages_dir(venv: Path) -> Path:
    if os.name == "nt":
        return venv / "Lib" / "site-packages"
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    return venv / "lib" / version / "site-packages"


def _add_windows_dll_dirs(venv: Path, site_packages: Path) -> None:
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return
    candidates = [
        venv,
        venv / "Scripts",
        site_packages,
        site_packages / "torch" / "lib",
        site_packages / "onnxruntime" / "capi",
    ]
    nvidia_root = site_packages / "nvidia"
    if nvidia_root.exists():
        candidates.extend(path for path in nvidia_root.rglob("bin") if path.is_dir())
    for path in candidates:
        if not path.exists():
            continue
        try:
            os.add_dll_directory(str(path))
        except OSError:
            pass
