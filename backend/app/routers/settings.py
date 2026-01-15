"""Settings management router."""
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..services.settings import SettingsManager, migrate_data_directory

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsResponse(BaseModel):
    data_dir: str
    database_path: str
    posts_dir: str
    thumbs_dir: str
    uploads_dir: str


class UpdateDataDirRequest(BaseModel):
    data_dir: str
    migrate: bool = False


class MigrationResponse(BaseModel):
    success: bool
    message: str
    old_path: Optional[str] = None
    new_path: Optional[str] = None
    files_copied: Optional[int] = None
    directories_copied: Optional[int] = None


@router.get("")
async def get_settings():
    """Get current settings."""
    settings_manager = SettingsManager(settings.config_file)
    configured_dir = settings_manager.get_data_dir()
    
    return SettingsResponse(
        data_dir=str(settings.data_dir),
        database_path=str(settings.database_path),
        posts_dir=str(settings.posts_dir),
        thumbs_dir=str(settings.thumbs_dir),
        uploads_dir=str(settings.uploads_dir),
    )


@router.put("/data-dir")
async def update_data_dir(request: UpdateDataDirRequest):
    """Update data directory path."""
    settings_manager = SettingsManager(settings.config_file)
    
    # Normalize the path
    new_path = settings_manager.normalize_path(request.data_dir)
    new_path_obj = Path(new_path)
    
    # Validate the path
    if not new_path_obj.parent.exists():
        raise HTTPException(
            status_code=400,
            detail=f"Parent directory does not exist: {new_path_obj.parent}"
        )
    
    # Check if migration is needed
    old_path = settings.data_dir
    needs_migration = old_path.exists() and old_path != new_path_obj
    
    if needs_migration:
        if not request.migrate:
            return {
                "needs_migration": True,
                "old_path": str(old_path),
                "new_path": new_path,
                "message": "Data directory exists at old location. Set migrate=true to migrate data."
            }
        
        # Perform migration
        result = migrate_data_directory(old_path, new_path_obj)
        
        if not result["success"]:
            raise HTTPException(
                status_code=500,
                detail=result["message"]
            )
    
    # Update settings
    settings_manager.set_data_dir(new_path)
    
    # Recreate directory structure at new location
    new_path_obj.mkdir(parents=True, exist_ok=True)
    (new_path_obj / "posts").mkdir(parents=True, exist_ok=True)
    (new_path_obj / "thumbs").mkdir(parents=True, exist_ok=True)
    (new_path_obj / "uploads").mkdir(parents=True, exist_ok=True)
    
    response = {
        "success": True,
        "message": "Data directory updated successfully",
        "new_path": new_path
    }
    
    if needs_migration and request.migrate:
        response["migration"] = result
    
    return response


@router.post("/migrate")
async def migrate_data(request: UpdateDataDirRequest):
    """Migrate data from current location to new location."""
    settings_manager = SettingsManager(settings.config_file)
    old_path = settings.data_dir
    new_path_obj = Path(settings_manager.normalize_path(request.data_dir))
    
    result = migrate_data_directory(old_path, new_path_obj)
    
    if result["success"]:
        # Update settings after successful migration
        settings_manager.set_data_dir(str(new_path_obj))
    
    return MigrationResponse(**result)
