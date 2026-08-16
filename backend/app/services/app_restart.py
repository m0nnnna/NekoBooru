"""Runtime restart coordination for NekoBooru launchers."""
from __future__ import annotations

import threading
from typing import Any, Callable

from ..runtime_paths import runtime_paths

_restart_lock = threading.Lock()
_restart_handler: Callable[[], dict[str, Any]] | None = None


def register_restart_handler(handler: Callable[[], dict[str, Any]]) -> None:
    """Register a process-level restart handler.

    Some launchers, such as Uvicorn reload mode, intentionally do not register
    a handler because they are controlled by an external supervisor.
    """
    global _restart_handler
    with _restart_lock:
        _restart_handler = handler


def clear_restart_handler() -> None:
    global _restart_handler
    with _restart_lock:
        _restart_handler = None


def restart_status() -> dict[str, Any]:
    with _restart_lock:
        available = _restart_handler is not None
    return {
        "available": available,
        "mode": "packaged" if runtime_paths.packaged else "source",
        "message": (
            "NekoBooru can restart itself."
            if available
            else "Restart is unavailable for this launcher. Restart this NekoBooru process from the terminal."
        ),
    }


def request_restart() -> dict[str, Any]:
    with _restart_lock:
        handler = _restart_handler
    if handler is None:
        raise RuntimeError(restart_status()["message"])
    return handler()
