"""Settings management router."""
import os
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models import Post
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


class StatsResponse(BaseModel):
    total_files: int
    images: int
    gifs: int
    videos: int
    total_size: int
    total_size_formatted: str
    oldest_post: Optional[str] = None
    newest_post: Optional[str] = None
    database_size: int
    database_size_formatted: str


def format_size(size_bytes: int) -> str:
    """Format bytes into human readable string."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


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


@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    """Get server statistics."""
    # Image extensions (without the dot prefix stored in DB)
    image_exts = ['.jpg', '.jpeg', '.png', '.webp']
    gif_exts = ['.gif']
    video_exts = ['.webm', '.mp4']

    # Count total files
    total_result = await db.execute(select(func.count(Post.id)))
    total_files = total_result.scalar() or 0

    # Count images
    images_result = await db.execute(
        select(func.count(Post.id)).where(Post.extension.in_(image_exts))
    )
    images = images_result.scalar() or 0

    # Count GIFs
    gifs_result = await db.execute(
        select(func.count(Post.id)).where(Post.extension.in_(gif_exts))
    )
    gifs = gifs_result.scalar() or 0

    # Count videos
    videos_result = await db.execute(
        select(func.count(Post.id)).where(Post.extension.in_(video_exts))
    )
    videos = videos_result.scalar() or 0

    # Total file size
    size_result = await db.execute(select(func.sum(Post.file_size)))
    total_size = size_result.scalar() or 0

    # Oldest and newest posts
    oldest_result = await db.execute(
        select(func.min(Post.created_at))
    )
    oldest_post = oldest_result.scalar()

    newest_result = await db.execute(
        select(func.max(Post.created_at))
    )
    newest_post = newest_result.scalar()

    # Database file size
    db_size = 0
    if settings.database_path.exists():
        db_size = os.path.getsize(settings.database_path)

    return StatsResponse(
        total_files=total_files,
        images=images,
        gifs=gifs,
        videos=videos,
        total_size=total_size,
        total_size_formatted=format_size(total_size),
        oldest_post=oldest_post.isoformat() if oldest_post else None,
        newest_post=newest_post.isoformat() if newest_post else None,
        database_size=db_size,
        database_size_formatted=format_size(db_size),
    )
