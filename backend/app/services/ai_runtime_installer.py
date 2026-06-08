"""Managed optional AI runtime installer job scaffolding."""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from ..runtime_paths import runtime_paths


DEFAULT_PROFILES = {
    "auto": {
        "id": "auto",
        "label": "Auto-detect NVIDIA GPU",
        "description": "Detects NVIDIA compute capability and installs GPU, legacy GPU, or CPU dependencies.",
        "requirements": None,
        "downloadSize": "~3-8 GB",
        "vram": "Depends on selected models",
    },
    "cpu": {
        "id": "cpu",
        "label": "Local CPU AI",
        "description": "No CUDA required. Slower, but works on most machines.",
        "requirements": "backend/requirements-tagger-cpu.txt",
        "downloadSize": "~3-5 GB",
        "vram": "0 GB",
    },
    "gpu-cu128": {
        "id": "gpu-cu128",
        "label": "Local NVIDIA AI",
        "description": "CUDA 12.8 PyTorch wheels for newer NVIDIA GPUs.",
        "requirements": "backend/requirements-tagger.txt",
        "downloadSize": "~6-8 GB",
        "vram": "Model dependent",
    },
    "gpu-cu126-legacy": {
        "id": "gpu-cu126-legacy",
        "label": "Local legacy NVIDIA AI",
        "description": "CUDA 12.6 wheels for GTX 10-series/Pascal cards.",
        "requirements": "backend/requirements-tagger-legacy.txt",
        "downloadSize": "~6-8 GB",
        "vram": "Model dependent",
    },
    "remote": {
        "id": "remote",
        "label": "Remote/server AI",
        "description": "Do not install local CUDA wheels; configure a remote GPU worker.",
        "requirements": None,
        "downloadSize": "0 GB on this client",
        "vram": "Remote worker",
    },
}


_job: dict[str, Any] | None = None
_job_lock = threading.Lock()
_process: subprocess.Popen | None = None


def _repo_root() -> Path:
    if runtime_paths.packaged:
        return runtime_paths.app_dir
    return Path(__file__).resolve().parents[3]


def _venv_bootstrap_python() -> list[str]:
    if not runtime_paths.packaged:
        return [sys.executable]
    override = os.environ.get("NEKO_PYTHON")
    if override:
        return [override]
    python = shutil.which("python")
    if python:
        return [python]
    py = shutil.which("py")
    if py:
        return [py, "-3"]
    raise RuntimeError("Python was not found. Install Python 3.10+ or set NEKO_PYTHON before installing the AI runtime.")


def _python_in_venv() -> Path:
    if platform.system().lower() == "windows":
        return runtime_paths.ai_venv_dir / "Scripts" / "python.exe"
    return runtime_paths.ai_venv_dir / "bin" / "python"


def _receipt_path() -> Path:
    return runtime_paths.ai_venv_dir / "nekobooru-ai-runtime.json"


def profiles() -> dict:
    return {"profiles": list(DEFAULT_PROFILES.values()), "installJob": current_job(), "installed": installed_receipt()}


def installed_receipt() -> dict | None:
    path = _receipt_path()
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def current_job() -> dict | None:
    with _job_lock:
        return json.loads(json.dumps(_job)) if _job else None


def start_install(profile_id: str, force: bool = False) -> dict:
    profile_id = str(profile_id or "auto").strip()
    if profile_id not in DEFAULT_PROFILES:
        raise ValueError(f"Unknown AI runtime profile: {profile_id}")
    if profile_id == "remote":
        receipt = _write_receipt(profile_id, {"verified": True, "remoteOnly": True})
        return {"status": "completed", "profile": profile_id, "receipt": receipt}

    receipt = installed_receipt()
    if receipt and receipt.get("profile") == profile_id and receipt.get("verified") and not force:
        return {
            "id": "already-installed",
            "status": "completed",
            "profile": profile_id,
            "progress": 100,
            "message": "AI runtime already installed and verified",
            "receipt": receipt,
        }

    global _job
    with _job_lock:
        if _job and _job.get("status") in {"queued", "running"}:
            return json.loads(json.dumps(_job))
        _job = {
            "id": str(uuid.uuid4()),
            "status": "queued",
            "profile": profile_id,
            "progress": 0,
            "message": "Queued AI runtime install",
            "startedAt": time.time(),
            "updatedAt": time.time(),
            "finishedAt": None,
            "error": None,
            "output": "",
        }
        snapshot = json.loads(json.dumps(_job))
    threading.Thread(target=_run_install, args=(snapshot["id"], profile_id), daemon=True).start()
    return snapshot


def cancel_install() -> dict:
    global _process
    with _job_lock:
        if not _job or _job.get("status") not in {"queued", "running"}:
            return current_job() or {"status": "idle"}
        _job["status"] = "cancelling"
        _job["message"] = "Cancelling AI runtime install"
        _job["updatedAt"] = time.time()
    if _process and _process.poll() is None:
        _process.terminate()
    return current_job()


def _set_job(job_id: str, **updates) -> None:
    with _job_lock:
        if not _job or _job.get("id") != job_id:
            return
        _job.update(updates)
        _job["updatedAt"] = time.time()


def _run_install(job_id: str, profile_id: str) -> None:
    global _process
    try:
        _set_job(job_id, status="running", progress=5, message="Creating managed AI virtual environment")
        runtime_paths.ai_venv_dir.mkdir(parents=True, exist_ok=True)
        py = _python_in_venv()
        if not py.exists():
            _run(job_id, [*_venv_bootstrap_python(), "-m", "venv", str(runtime_paths.ai_venv_dir)], 15)

        _set_job(job_id, progress=25, message="Installing base backend dependencies")
        _run(job_id, [str(py), "-m", "pip", "install", "--upgrade", "pip"], 30)
        _run(job_id, [str(py), "-m", "pip", "install", "-r", str(_repo_root() / "backend" / "requirements.txt")], 45)

        req = _requirements_for(profile_id)
        _set_job(job_id, progress=55, message=f"Installing {DEFAULT_PROFILES[profile_id]['label']} dependencies")
        _run(job_id, [str(py), "-m", "pip", "install", "-r", str(req)], 85)

        _set_job(job_id, progress=90, message="Verifying AI runtime")
        verify = _verify_runtime(py)
        receipt = _write_receipt(profile_id, verify)
        try:
            from ..ai_runtime_link import link_ai_runtime

            link_ai_runtime()
        except Exception:
            pass
        _set_job(
            job_id,
            status="completed",
            progress=100,
            message="AI runtime installed and verified",
            finishedAt=time.time(),
            receipt=receipt,
        )
    except Exception as exc:  # noqa: BLE001
        _set_job(job_id, status="failed", error=str(exc), message="AI runtime install failed", finishedAt=time.time())
    finally:
        _process = None


def _run(job_id: str, cmd: list[str], progress: int) -> None:
    global _process
    env = {**os.environ, "PYTHONUTF8": "1"}
    _process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", env=env)
    output = []
    assert _process.stdout is not None
    for line in _process.stdout:
        output.append(line)
        with _job_lock:
            if _job and _job.get("id") == job_id:
                _job["output"] = ("".join(output))[-12000:]
                _job["progress"] = max(int(_job.get("progress") or 0), progress)
                _job["updatedAt"] = time.time()
    code = _process.wait()
    if code != 0:
        raise RuntimeError(f"Command failed with exit code {code}: {' '.join(cmd[:4])}")


def _requirements_for(profile_id: str) -> Path:
    if profile_id == "auto":
        profile_id = _auto_profile()
    req = DEFAULT_PROFILES[profile_id].get("requirements")
    if not req:
        raise ValueError(f"Profile {profile_id} does not install a local runtime")
    return _repo_root() / str(req)


def _auto_profile() -> str:
    try:
        proc = subprocess.run(
            ["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=False,
        )
        majors = []
        for line in (proc.stdout or "").splitlines():
            head = line.strip().split(".", 1)[0]
            if head.isdigit():
                majors.append(int(head))
        if not majors:
            return "cpu"
        major = max(majors)
        if major >= 7:
            return "gpu-cu128"
        if major == 6:
            return "gpu-cu126-legacy"
        return "cpu"
    except Exception:
        return "cpu"


def _verify_runtime(py: Path) -> dict:
    script = (
        "import json, importlib.util\n"
        "info={'verified': True}\n"
        "try:\n"
        " import torch\n"
        " info['torch']=torch.__version__; info['cudaAvailable']=bool(torch.cuda.is_available())\n"
        "except Exception as exc: info['torchError']=str(exc)\n"
        "try:\n"
        " import onnxruntime as ort\n"
        " info['onnxruntime']=ort.__version__; info['onnxProviders']=ort.get_available_providers()\n"
        "except Exception as exc: info['onnxError']=str(exc)\n"
        "print(json.dumps(info))\n"
    )
    proc = subprocess.run([str(py), "-c", script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(proc.stdout[-2000:] or "runtime verification failed")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _write_receipt(profile_id: str, extra: dict) -> dict:
    receipt = {
        "profile": profile_id,
        "installedAt": time.time(),
        "python": str(_python_in_venv()),
        **extra,
    }
    runtime_paths.ai_venv_dir.mkdir(parents=True, exist_ok=True)
    _receipt_path().write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    return receipt
