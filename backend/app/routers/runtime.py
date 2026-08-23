"""Runtime diagnostics and packaged AI runtime installer endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..dependencies import get_current_user
from ..models import User
from ..services import ai_runtime_installer
from ..services.app_restart import request_restart
from ..services.runtime_diagnostics import runtime_status


router = APIRouter(prefix="/api/runtime", tags=["runtime"])


class AiRuntimeInstallRequest(BaseModel):
    profile: str = "auto"
    force: bool = False


@router.get("/status")
async def get_runtime_status(current_user: User = Depends(get_current_user)):
    return runtime_status()


@router.get("/ai/profiles")
async def get_ai_runtime_profiles(current_user: User = Depends(get_current_user)):
    return ai_runtime_installer.profiles()


@router.post("/ai/install")
async def install_ai_runtime(body: AiRuntimeInstallRequest, current_user: User = Depends(get_current_user)):
    try:
        return ai_runtime_installer.start_install(body.profile, force=body.force)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/ai/install-job")
async def get_ai_runtime_install_job(current_user: User = Depends(get_current_user)):
    return ai_runtime_installer.current_job()


@router.post("/ai/cancel-install")
async def cancel_ai_runtime_install(current_user: User = Depends(get_current_user)):
    return ai_runtime_installer.cancel_install()


@router.post("/restart")
async def restart_app(current_user: User = Depends(get_current_user)):
    try:
        return request_restart()
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
