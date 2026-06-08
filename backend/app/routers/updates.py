"""Application update endpoints."""
from fastapi import APIRouter
from pydantic import BaseModel

from ..services import update_service

router = APIRouter(prefix="/api/updates", tags=["updates"])


class UpdateSettingsRequest(BaseModel):
    owner: str = update_service.DEFAULT_OWNER
    repo: str = update_service.DEFAULT_REPO
    channel: str = "stable"
    autoCheck: bool = True
    autoDownload: bool = False
    includePrereleases: bool = False


@router.get("/status")
async def get_update_status(auto: bool = False):
    return update_service.status(auto_check=auto)


@router.put("/settings")
async def put_update_settings(request: UpdateSettingsRequest):
    return update_service.save_settings(request.model_dump())


@router.post("/check")
async def check_updates():
    return update_service.check_now()
