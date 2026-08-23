"""Settings management router."""
import os
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..dependencies import get_current_user
from ..models import Post, User
from ..services.auth import visible_owner_ids
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
    frontend_port: int
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
    frontend_port: int = 5173
    cors_origins: str = ""


class ExtensionSettingsRequest(BaseModel):
    saveTweetTag: bool = True
    saveTweetUsername: bool = False
    saveSourcePageUrl: bool = True
    saveMediaUrl: bool = False
    saveSemanticAnalysis: bool = False
    modelDefaults: dict = Field(default_factory=dict)


class AiModelDefaultsRequest(BaseModel):
    modelDefaults: dict = Field(default_factory=dict)


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


def _ai_model_defaults_payload(raw: dict | None = None) -> dict:
    if raw is None:
        manager = SettingsManager(settings.config_file)
        raw = manager.get_ai_model_defaults()
        if not raw:
            # Compatibility for settings saved before model defaults became shared.
            extension = manager.get_extension_settings()
            raw = extension.get("modelDefaults") if isinstance(extension.get("modelDefaults"), dict) else {}
    model_defaults = raw.get("modelDefaults") if isinstance(raw.get("modelDefaults"), dict) else raw
    model_defaults = model_defaults if isinstance(model_defaults, dict) else {}
    normalized_model_defaults = _normalize_ai_model_default_stack(model_defaults)
    profile_defaults_raw = raw.get("profileDefaults") if isinstance(raw.get("profileDefaults"), dict) else {}
    profile_defaults = {}
    for profile in ("custom", "anime", "realistic"):
        raw_profile = profile_defaults_raw.get(profile) if isinstance(profile_defaults_raw, dict) else None
        if isinstance(raw_profile, dict):
            profile_defaults[profile] = _normalize_ai_model_default_stack(raw_profile)
    if profile_defaults:
        if "custom" not in profile_defaults:
            profile_defaults["custom"] = normalized_model_defaults
        return {
            **normalized_model_defaults,
            "profileDefaults": profile_defaults,
        }
    return normalized_model_defaults


def _normalize_ai_model_default_stack(model_defaults: dict) -> dict:
    model_defaults = model_defaults if isinstance(model_defaults, dict) else {}
    normalized_model_defaults = {}
    for key in ("wdEnabled", "pixaiEnabled", "characterModelEnabled", "clEnabled", "booruLookupEnabled", "ocrEnabled", "whisperEnabled", "qwenEnabled", "semanticPoliticalEnabled"):
        if key in model_defaults:
            normalized_model_defaults[key] = model_defaults.get(key) is True
    if "qwenEnabled" in normalized_model_defaults and "semanticPoliticalEnabled" not in normalized_model_defaults:
        normalized_model_defaults["semanticPoliticalEnabled"] = normalized_model_defaults["qwenEnabled"]
    return normalized_model_defaults


def _extension_settings_payload(raw: dict | None = None) -> dict:
    raw = raw or SettingsManager(settings.config_file).get_extension_settings()
    return {
        "saveTweetTag": raw.get("saveTweetTag", True) is not False,
        "saveTweetUsername": raw.get("saveTweetUsername") is True,
        "saveSourcePageUrl": raw.get("saveSourcePageUrl", True) is not False,
        "saveMediaUrl": raw.get("saveMediaUrl") is True,
        "saveSemanticAnalysis": raw.get("saveSemanticAnalysis") is True,
        "modelDefaults": _ai_model_defaults_payload(),
    }


@router.get("")
async def get_settings(current_user: User = Depends(get_current_user)):
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
        frontend_port=settings.frontend_port,
        cors_origins=settings.cors_origins,
        server_restart_required=False,
        ytdlp_cookies_configured=cookies_configured,
    )


@router.put("/server")
async def update_server_settings(request: ServerSettingsRequest, current_user: User = Depends(get_current_user)):
    """Persist host/port/CORS settings for the next backend start."""
    host = str(request.host or "").strip() or "127.0.0.1"
    if host == "localhost":
        host = "127.0.0.1"
    if not (1 <= int(request.port) <= 65535):
        raise HTTPException(status_code=400, detail="Port must be between 1 and 65535")
    if not (1 <= int(request.frontend_port) <= 65535):
        raise HTTPException(status_code=400, detail="Frontend port must be between 1 and 65535")

    cors = str(request.cors_origins or "").strip()
    if not cors:
        cors = (
            f"http://localhost:{int(request.port)},http://127.0.0.1:{int(request.port)},"
            f"http://localhost:{int(request.frontend_port)},http://127.0.0.1:{int(request.frontend_port)}"
        )

    server_settings = {
        "host": host,
        "port": int(request.port),
        "frontendPort": int(request.frontend_port),
        "corsOrigins": cors,
    }
    SettingsManager(settings.config_file).set_server_settings(server_settings)
    return {
        **server_settings,
        "restartRequired": (
            host != settings.host
            or int(request.port) != settings.port
            or int(request.frontend_port) != settings.frontend_port
            or cors != settings.cors_origins
        ),
        "message": "Server settings saved. Restart NekoBooru/dev frontend for port changes to take effect.",
    }


@router.get("/extension")
async def get_extension_settings(current_user: User = Depends(get_current_user)):
    """Get defaults used by the browser extension upload popup."""
    return _extension_settings_payload()


@router.put("/extension")
async def update_extension_settings(
    request: ExtensionSettingsRequest, current_user: User = Depends(get_current_user)
):
    """Persist defaults used by the browser extension upload popup."""
    request_payload = request.model_dump()
    payload = _extension_settings_payload(request_payload)
    if request.modelDefaults:
        payload["modelDefaults"] = _ai_model_defaults_payload(request.modelDefaults)
        SettingsManager(settings.config_file).set_ai_model_defaults(payload["modelDefaults"])
    SettingsManager(settings.config_file).set_extension_settings({
        "saveTweetTag": payload["saveTweetTag"],
        "saveTweetUsername": payload["saveTweetUsername"],
        "saveSourcePageUrl": payload["saveSourcePageUrl"],
        "saveMediaUrl": payload["saveMediaUrl"],
        "saveSemanticAnalysis": payload["saveSemanticAnalysis"],
    })
    return payload


@router.get("/ai-model-defaults")
async def get_ai_model_defaults(current_user: User = Depends(get_current_user)):
    """Get shared model choices used by app post previews and the browser extension."""
    return {"modelDefaults": _ai_model_defaults_payload()}


@router.put("/ai-model-defaults")
async def update_ai_model_defaults(
    request: AiModelDefaultsRequest, current_user: User = Depends(get_current_user)
):
    """Persist shared model choices used by app post previews and the browser extension."""
    model_defaults = _ai_model_defaults_payload(request.modelDefaults)
    SettingsManager(settings.config_file).set_ai_model_defaults(model_defaults)
    return {"modelDefaults": model_defaults}


@router.put("/data-dir")
async def update_data_dir(request: UpdateDataDirRequest, current_user: User = Depends(get_current_user)):
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
async def migrate_data(request: UpdateDataDirRequest, current_user: User = Depends(get_current_user)):
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
async def upload_ytdlp_cookies(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
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
async def delete_ytdlp_cookies(current_user: User = Depends(get_current_user)):
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
async def get_ytdlp_status(current_user: User = Depends(get_current_user)):
    """Get yt-dlp version, import path, update policy, and update job state."""
    return ytdlp_manager.status()


@router.put("/ytdlp")
async def update_ytdlp_settings(request: YtdlpSettingsRequest, current_user: User = Depends(get_current_user)):
    """Persist yt-dlp update policy."""
    return ytdlp_manager.save_settings(request.model_dump())


@router.post("/ytdlp/update")
async def update_ytdlp(request: YtdlpUpdateRequest, current_user: User = Depends(get_current_user)):
    """Start a background yt-dlp pip update in the backend Python environment."""
    try:
        return await ytdlp_manager.start_update(request.target)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/dashboard")
async def get_dashboard(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Rich library statistics for the dashboard view - this user's own library plus whatever's shared with them."""
    from ..models import Tag, TagCategory, Pool, Favorite, Comment, Note
    from ..models.post import PostTag

    image_exts = ['.jpg', '.jpeg', '.png', '.webp']
    gif_exts = ['.gif']
    video_exts = ['.webm', '.mp4']

    owner_ids = await visible_owner_ids(db, current_user)
    live = (Post.deleted_at.is_(None), Post.owner_id.in_(owner_ids))
    own_posts = select(Post.id).where(*live).subquery()

    async def scalar(stmt):
        return (await db.execute(stmt)).scalar() or 0

    total_posts = await scalar(select(func.count(Post.id)).where(*live))
    images = await scalar(select(func.count(Post.id)).where(*live, Post.extension.in_(image_exts)))
    gifs = await scalar(select(func.count(Post.id)).where(*live, Post.extension.in_(gif_exts)))
    videos = await scalar(select(func.count(Post.id)).where(*live, Post.extension.in_(video_exts)))

    safe = await scalar(select(func.count(Post.id)).where(*live, Post.safety == "safe"))
    sketchy = await scalar(select(func.count(Post.id)).where(*live, Post.safety == "sketchy"))
    unsafe = await scalar(select(func.count(Post.id)).where(*live, Post.safety == "unsafe"))

    total_size = await scalar(select(func.sum(Post.file_size)).where(*live))
    oldest = (await db.execute(select(func.min(Post.created_at)).where(*live))).scalar()
    newest = (await db.execute(select(func.max(Post.created_at)).where(*live))).scalar()

    tagged_subq = select(PostTag.c.post_id).distinct().subquery()
    untagged = await scalar(
        select(func.count(Post.id)).where(*live, Post.id.not_in(select(tagged_subq.c.post_id)))
    )

    total_tags = await scalar(select(func.count(Tag.id)))
    total_pools = await scalar(select(func.count(Pool.id)).where(Pool.owner_id.in_(owner_ids)))
    total_favorites = await scalar(select(func.count(Favorite.id)).where(Favorite.user_id == current_user.id))
    total_comments = await scalar(
        select(func.count(Comment.id)).join(Post, Post.id == Comment.post_id).where(Post.owner_id.in_(owner_ids))
    )
    total_notes = await scalar(
        select(func.count(Note.id)).join(Post, Post.id == Note.post_id).where(Post.owner_id.in_(owner_ids))
    )

    # Uploads per month (ISO YYYY-MM), oldest first.
    month = func.strftime("%Y-%m", Post.created_at)
    uploads_rows = (
        await db.execute(
            select(month.label("m"), func.count(Post.id)).where(*live).group_by("m").order_by("m")
        )
    ).all()
    uploads_by_month = [{"month": m, "count": c} for m, c in uploads_rows if m]

    # Top tags by live usage within this user's visible posts (excludes
    # deleted posts and posts outside owner_ids).
    top_rows = (
        await db.execute(
            select(Tag.name, TagCategory.color, func.count(PostTag.c.post_id).label("n"))
            .join(PostTag, PostTag.c.tag_id == Tag.id)
            .join(own_posts, own_posts.c.id == PostTag.c.post_id)
            .outerjoin(TagCategory, TagCategory.id == Tag.category_id)
            .group_by(Tag.id)
            .order_by(func.count(PostTag.c.post_id).desc())
            .limit(25)
        )
    ).all()
    top_tags = [{"name": n, "color": c or "#808080", "count": cnt} for n, c, cnt in top_rows]

    # Tag counts per category - stays instance-wide (shared vocabulary, not
    # private content; see the tag-scoping decision in the multi-user plan).
    cat_rows = (
        await db.execute(
            select(TagCategory.name, TagCategory.color, func.count(Tag.id))
            .outerjoin(Tag, Tag.category_id == TagCategory.id)
            .group_by(TagCategory.id)
            .order_by(TagCategory.order)
        )
    ).all()
    tags_by_category = [{"name": n, "color": c, "count": cnt} for n, c, cnt in cat_rows]

    # Near-duplicate groups (identical perceptual hash) and unhashed backlog.
    dup_groups = await scalar(
        select(func.count())
        .select_from(
            select(Post.phash)
            .where(*live, Post.phash.is_not(None), Post.phash != "")
            .group_by(Post.phash)
            .having(func.count(Post.id) > 1)
            .subquery()
        )
    )
    phash_missing = await scalar(select(func.count(Post.id)).where(*live, Post.phash.is_(None)))

    db_size = os.path.getsize(settings.database_path) if settings.database_path.exists() else 0

    return {
        "totals": {
            "posts": total_posts,
            "tags": total_tags,
            "pools": total_pools,
            "favorites": total_favorites,
            "comments": total_comments,
            "notes": total_notes,
        },
        "types": {"images": images, "gifs": gifs, "videos": videos},
        "safety": {"safe": safe, "sketchy": sketchy, "unsafe": unsafe},
        "untagged": untagged,
        "totalSize": total_size,
        "totalSizeFormatted": format_size(total_size),
        "avgSize": total_size // total_posts if total_posts else 0,
        "avgSizeFormatted": format_size(total_size // total_posts) if total_posts else "0 B",
        "oldestPost": oldest.isoformat() if oldest else None,
        "newestPost": newest.isoformat() if newest else None,
        "databaseSize": db_size,
        "databaseSizeFormatted": format_size(db_size),
        "uploadsByMonth": uploads_by_month,
        "topTags": top_tags,
        "tagsByCategory": tags_by_category,
        "duplicateGroups": dup_groups,
        "phashMissing": phash_missing,
    }


@router.get("/stats")
async def get_stats(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get server statistics for this user's own library plus whatever's shared with them."""
    # Image extensions (without the dot prefix stored in DB)
    image_exts = ['.jpg', '.jpeg', '.png', '.webp']
    gif_exts = ['.gif']
    video_exts = ['.webm', '.mp4']

    owner_ids = await visible_owner_ids(db, current_user)
    owned = Post.owner_id.in_(owner_ids)

    # Count total files
    total_result = await db.execute(select(func.count(Post.id)).where(owned))
    total_files = total_result.scalar() or 0

    # Count images
    images_result = await db.execute(
        select(func.count(Post.id)).where(owned, Post.extension.in_(image_exts))
    )
    images = images_result.scalar() or 0

    # Count GIFs
    gifs_result = await db.execute(
        select(func.count(Post.id)).where(owned, Post.extension.in_(gif_exts))
    )
    gifs = gifs_result.scalar() or 0

    # Count videos
    videos_result = await db.execute(
        select(func.count(Post.id)).where(owned, Post.extension.in_(video_exts))
    )
    videos = videos_result.scalar() or 0

    # Total file size
    size_result = await db.execute(select(func.sum(Post.file_size)).where(owned))
    total_size = size_result.scalar() or 0

    # Oldest and newest posts
    oldest_result = await db.execute(
        select(func.min(Post.created_at)).where(owned)
    )
    oldest_post = oldest_result.scalar()

    newest_result = await db.execute(
        select(func.max(Post.created_at)).where(owned)
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
