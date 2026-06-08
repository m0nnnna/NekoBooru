#!/usr/bin/env python
"""Native messaging host that starts local NekoBooru.

In source mode it starts the backend plus Vite frontend. In packaged mode it
starts the installed app executable and uses the backend-served UI.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import webbrowser
from pathlib import Path


HOST = "127.0.0.1"
BACKEND_PORT = 8772
FRONTEND_PORT = 5173
APP_EXE = "nekobooru.exe"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def user_root() -> Path:
    if os.name != "nt":
        base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
        return Path(base) / "nekobooru"
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "NekoBooru"


def config_path() -> Path:
    return user_root() / "native-messaging-hosts" / "launcher-config.json"


def load_config() -> dict:
    path = config_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def source_server_config() -> dict:
    path = repo_root() / "config" / "settings.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return dict(data.get("server") or {})
    except Exception:
        return {}


def source_backend_port() -> int:
    try:
        return int(source_server_config().get("port") or os.environ.get("NEKO_PORT") or BACKEND_PORT)
    except Exception:
        return BACKEND_PORT


def source_frontend_port() -> int:
    try:
        return int(source_server_config().get("frontendPort") or os.environ.get("NEKO_FRONTEND_PORT") or FRONTEND_PORT)
    except Exception:
        return FRONTEND_PORT


def packaged_backend_port() -> int:
    cfg = load_config()
    try:
        return int(cfg.get("backendPort") or cfg.get("port") or BACKEND_PORT)
    except Exception:
        return BACKEND_PORT


def registry_install_path() -> Path | None:
    if os.name != "nt":
        return None
    try:
        import winreg

        keys = [
            r"Software\NekoBooru",
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\NekoBooru",
        ]
        for key_name in keys:
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_name) as key:
                    raw = winreg.QueryValueEx(key, "InstallLocation")[0]
                    if raw:
                        return Path(raw)
            except OSError:
                continue
    except Exception:
        return None
    return None


def installed_app_path() -> Path | None:
    cfg = load_config()
    candidates = []
    if cfg.get("appPath"):
        candidates.append(Path(cfg["appPath"]))
    if os.name == "nt":
        reg = registry_install_path()
        if reg:
            candidates.append(reg / APP_EXE if reg.is_dir() else reg)
        candidates.extend([
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "NekoBooru" / APP_EXE,
            user_root() / APP_EXE,
        ])
    else:
        candidates.extend([
            Path("/usr/bin/nekobooru"),
            Path("/usr/local/bin/nekobooru"),
            Path("/opt/nekobooru/nekobooru"),
        ])
    for candidate in candidates:
        try:
            if candidate and candidate.exists():
                return candidate.resolve()
        except OSError:
            continue
    return None


def is_port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((HOST, port)) == 0


def popen_hidden(args: list[str], cwd: Path, log_path: Path) -> None:
    creationflags = 0
    startupinfo = None
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("ab")
    subprocess.Popen(
        args,
        cwd=str(cwd),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
        startupinfo=startupinfo,
        close_fds=True,
    )


def start_servers() -> dict:
    app_path = installed_app_path()
    if app_path:
        return start_packaged_app(app_path)
    return start_source_servers()


def start_packaged_app(app_path: Path) -> dict:
    if os.name == "nt":
        logs = user_root() / "logs"
    else:
        logs = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "nekobooru" / "logs"
    backend_port = packaged_backend_port()
    backend_running = is_port_open(backend_port)
    if not backend_running:
        popen_hidden([str(app_path)], app_path.parent, logs / "native-packaged-app.log")
    return {
        "ok": True,
        "mode": "packaged",
        "appPath": str(app_path),
        "backendAlreadyRunning": backend_running,
        "frontendAlreadyRunning": backend_running,
        "backendUrl": f"http://{HOST}:{backend_port}",
        "frontendUrl": f"http://{HOST}:{backend_port}",
        "logs": str(logs),
    }


def start_source_servers() -> dict:
    root = repo_root()
    logs = root / "logs"
    backend_port = source_backend_port()
    frontend_port = source_frontend_port()
    backend_running = is_port_open(backend_port)
    frontend_running = is_port_open(frontend_port)

    if not backend_running:
        python = root / "venv" / "Scripts" / "python.exe"
        if not python.exists():
            python = Path(sys.executable)
        popen_hidden([str(python), "run_prod.py"], root / "backend", logs / "native-backend.log")

    if not frontend_running:
        npm = "npm.cmd" if os.name == "nt" else "npm"
        popen_hidden([npm, "run", "dev", "--", "--host", HOST, "--port", str(frontend_port)], root / "frontend", logs / "native-frontend.log")

    return {
        "ok": True,
        "mode": "source",
        "backendAlreadyRunning": backend_running,
        "frontendAlreadyRunning": frontend_running,
        "backendUrl": f"http://{HOST}:{backend_port}",
        "frontendUrl": f"http://{HOST}:{frontend_port}",
    }


def status() -> dict:
    app_path = installed_app_path()
    backend_port = packaged_backend_port() if app_path else source_backend_port()
    frontend_port = backend_port if app_path else source_frontend_port()
    backend_running = is_port_open(backend_port)
    frontend_running = is_port_open(frontend_port)
    return {
        "ok": True,
        "mode": "packaged" if app_path else "source",
        "appPath": str(app_path) if app_path else "",
        "backendRunning": backend_running,
        "frontendRunning": frontend_running,
        "backendUrl": f"http://{HOST}:{backend_port}",
        "frontendUrl": f"http://{HOST}:{frontend_port}",
    }


def open_ui() -> dict:
    info = status()
    url = info["frontendUrl"]
    webbrowser.open(url)
    return {**info, "opened": url}


def read_message() -> dict | None:
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack("<I", raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def write_message(message: dict) -> None:
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main() -> None:
    try:
        message = read_message()
        if not message:
            return
        if message.get("command") == "start":
            write_message(start_servers())
        elif message.get("command") == "status":
            write_message(status())
        elif message.get("command") == "open":
            write_message(open_ui())
        else:
            write_message({"ok": False, "error": "Unknown command"})
    except Exception as exc:  # noqa: BLE001
        write_message({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
