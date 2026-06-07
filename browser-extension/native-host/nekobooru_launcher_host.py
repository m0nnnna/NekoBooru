#!/usr/bin/env python
"""Native messaging host that starts the local NekoBooru dev servers."""

from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
from pathlib import Path


HOST = "127.0.0.1"
BACKEND_PORT = 8772
FRONTEND_PORT = 5173


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


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
    root = repo_root()
    logs = root / "logs"
    backend_running = is_port_open(BACKEND_PORT)
    frontend_running = is_port_open(FRONTEND_PORT)

    if not backend_running:
        python = root / "venv" / "Scripts" / "python.exe"
        if not python.exists():
            python = Path(sys.executable)
        popen_hidden([str(python), "run_prod.py"], root / "backend", logs / "native-backend.log")

    if not frontend_running:
        npm = "npm.cmd" if os.name == "nt" else "npm"
        popen_hidden([npm, "run", "dev", "--", "--host", HOST], root / "frontend", logs / "native-frontend.log")

    return {
        "ok": True,
        "backendAlreadyRunning": backend_running,
        "frontendAlreadyRunning": frontend_running,
        "backendUrl": f"http://{HOST}:{BACKEND_PORT}",
        "frontendUrl": f"http://{HOST}:{FRONTEND_PORT}",
    }


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
        else:
            write_message({"ok": False, "error": "Unknown command"})
    except Exception as exc:  # noqa: BLE001
        write_message({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
