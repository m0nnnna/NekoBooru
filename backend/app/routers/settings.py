"""Settings management router."""
import os
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models import Post
from ..services.settings import SettingsManager, migrate_data_directory
from ..services import ytdlp_manager

# Fixed path for cookies file in config directory
COOKIES_FILENAME = "ytdlp_cookies.txt"

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsResponse(BaseModel):
    data_dir: str
    database_path: str
    posts_dir: str
    thumbs_dir: str
    uploads_dir: str
    host: str
    port: int
    cors_origins: str
    server_restart_required: bool = False
    ytdlp_cookies_configured: bool = False


class UpdateDataDirRequest(BaseModel):
    data_dir: str
    migrate: bool = False


class YtdlpSettingsRequest(BaseModel):
    updatePolicy: str = "manual"
    pinnedVersion: str = ""


class YtdlpUpdateRequest(BaseModel):
    target: str = "latest"


class ServerSettingsRequest(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8772
    cors_origins: str = ""


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
    # Check if cookies file exists in config directory
    cookies_file = settings.config_dir / COOKIES_FILENAME
    cookies_configured = cookies_file.exists() and cookies_file.is_file()

    return SettingsResponse(
        data_dir=str(settings.data_dir),
        database_path=str(settings.database_path),
        posts_dir=str(settings.posts_dir),
        thumbs_dir=str(settings.thumbs_dir),
        uploads_dir=str(settings.uploads_dir),
        host=settings.host,
        port=settings.port,
        cors_origins=settings.cors_origins,
        server_restart_required=False,
        ytdlp_cookies_configured=cookies_configured,
    )


@router.put("/server")
async def update_server_settings(request: ServerSettingsRequest):
    """Persist host/port/CORS settings for the next backend start."""
    host = str(request.host or "").strip() or "127.0.0.1"
    if host == "localhost":
        host = "127.0.0.1"
    if not (1 <= int(request.port) <= 65535):
        raise HTTPException(status_code=400, detail="Port must be between 1 and 65535")

    cors = str(request.cors_origins or "").strip()
    if not cors:
        cors = (
            f"http://localhost:{int(request.port)},http://127.0.0.1:{int(request.port)},"
            "http://localhost:5173,http://127.0.0.1:5173"
        )

    server_settings = {
        "host": host,
        "port": int(request.port),
        "corsOrigins": cors,
    }
    SettingsManager(settings.config_file).set_server_settings(server_settings)
    return {
        **server_settings,
        "restartRequired": host != settings.host or int(request.port) != settings.port or cors != settings.cors_origins,
        "message": "Server settings saved. Restart NekoBooru for host/port changes to take effect.",
    }


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


@router.post("/ytdlp-cookies")
async def upload_ytdlp_cookies(file: UploadFile = File(...)):
    """Upload yt-dlp cookies file."""
    # Validate file extension
    if not file.filename.endswith('.txt'):
        raise HTTPException(
            status_code=400,
            detail="Cookies file must be a .txt file"
        )

    # Read and validate content
    content = await file.read()

    # Basic validation - check if it looks like a Netscape cookies file
    try:
        text_content = content.decode('utf-8')
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="Invalid file encoding. Cookies file must be UTF-8 encoded text."
        )

    # Save to config directory
    cookies_file = settings.config_dir / COOKIES_FILENAME
    try:
        with open(cookies_file, 'wb') as f:
            f.write(content)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save cookies file: {str(e)}"
        )

    return {
        "success": True,
        "message": "Cookies file uploaded successfully",
    }


@router.delete("/ytdlp-cookies")
async def delete_ytdlp_cookies():
    """Delete the uploaded yt-dlp cookies file."""
    cookies_file = settings.config_dir / COOKIES_FILENAME

    if not cookies_file.exists():
        return {
            "success": True,
            "message": "No cookies file to delete",
        }

    try:
        cookies_file.unlink()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete cookies file: {str(e)}"
        )

    return {
        "success": True,
        "message": "Cookies file deleted successfully",
    }


@router.get("/ytdlp")
async def get_ytdlp_status():
    """Get yt-dlp version, import path, update policy, and update job state."""
    return ytdlp_manager.status()


@router.put("/ytdlp")
async def update_ytdlp_settings(request: YtdlpSettingsRequest):
    """Persist yt-dlp update policy."""
    return ytdlp_manager.save_settings(request.model_dump())


@router.post("/ytdlp/update")
async def update_ytdlp(request: YtdlpUpdateRequest):
    """Start a background yt-dlp pip update in the backend Python environment."""
    try:
        return await ytdlp_manager.start_update(request.target)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


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
