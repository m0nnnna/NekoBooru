"""Runtime diagnostics and packaged AI runtime installer endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import ai_runtime_installer
from ..services.runtime_diagnostics import runtime_status


router = APIRouter(prefix="/api/runtime", tags=["runtime"])


class AiRuntimeInstallRequest(BaseModel):
    profile: str = "auto"
    force: bool = False


@router.get("/status")
async def get_runtime_status():
    return runtime_status()


@router.get("/ai/profiles")
async def get_ai_runtime_profiles():
    return ai_runtime_installer.profiles()


@router.post("/ai/install")
async def install_ai_runtime(body: AiRuntimeInstallRequest):
    try:
        return ai_runtime_installer.start_install(body.profile, force=body.force)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/ai/install-job")
async def get_ai_runtime_install_job():
    return ai_runtime_installer.current_job()


@router.post("/ai/cancel-install")
async def cancel_ai_runtime_install():
    return ai_runtime_installer.cancel_install()
