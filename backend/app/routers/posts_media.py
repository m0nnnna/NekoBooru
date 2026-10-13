"""Favorites and authenticated media/thumbnail serving for posts.

Included into routers.posts.router, which re-exports every name here.
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..config import settings
from ..dependencies import get_current_user
from ..models import Favorite, Post, User
from ..services.auth import visible_owner_ids
from ..services.media import convert_video_to_gif

router = APIRouter()


@router.post("/posts/{post_id}/favorite")
async def toggle_favorite(
    post_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Toggle favorite status on a post for the current user.

    A shared-library viewer may favorite a post they can see, independently
    of the post's owner - so this looks up *this user's* favorite row, not
    just whether the post has one at all.
    """
    owner_ids = await visible_owner_ids(db, current_user)
    result = await db.execute(
        select(Post).options(selectinload(Post.favorites)).where(Post.id == post_id, Post.owner_id.in_(owner_ids))
    )
    post = result.scalars().first()

    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    existing = next((f for f in post.favorites if f.user_id == current_user.id), None)
    if existing:
        await db.delete(existing)
        is_favorited = False
    else:
        fav = Favorite(post_id=post_id, user_id=current_user.id)
        db.add(fav)
        is_favorited = True

    await db.commit()
    return {"isFavorited": is_favorited}


async def _require_media_access(filename: str, current_user: User, db: AsyncSession) -> None:
    """Media/thumb filenames are ``{sha256}{ext}`` - content-addressed, so the
    URL itself carries no owner info. Look the post up by its hash prefix and
    404 (not 403) if it's outside what this user can see, same as any other
    post lookup.
    """
    sha256_hex = filename[:64]
    owner_ids = await visible_owner_ids(db, current_user)
    result = await db.execute(select(Post.id).where(Post.sha256 == sha256_hex, Post.owner_id.in_(owner_ids)))
    if not result.scalars().first():
        raise HTTPException(status_code=404, detail="File not found")


# Media serving routes
@router.get("/media/posts/{subdir}/{filename}")
async def serve_post_media(
    subdir: str,
    filename: str,
    format: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Serve original post media files.

    Pass ``?format=gif`` on a video (mp4/webm) to download an animated GIF
    transcoded from the video. The conversion is cached so repeat requests are
    cheap. The stored file is never modified.
    """
    await _require_media_access(filename, current_user, db)
    file_path = settings.posts_dir / subdir / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    ext = Path(filename).suffix.lower()

    # On-demand video -> GIF conversion (cached by sha/filename).
    if format == "gif" and ext in (".mp4", ".webm"):
        gif_path = settings.cache_dir / subdir / f"{Path(filename).stem}.gif"
        if not gif_path.exists():
            if not convert_video_to_gif(file_path, gif_path):
                raise HTTPException(status_code=500, detail="Failed to convert video to GIF")
        return FileResponse(
            gif_path,
            media_type="image/gif",
            filename=f"{Path(filename).stem}.gif",
        )

    # Determine media type
    media_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".webm": "video/webm",
        ".mp4": "video/mp4",
    }
    media_type = media_types.get(ext, "application/octet-stream")

    return FileResponse(file_path, media_type=media_type)


@router.get("/media/thumbs/{subdir}/{filename}")
async def serve_thumbnail(
    subdir: str,
    filename: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Serve thumbnail files."""
    await _require_media_access(filename, current_user, db)
    file_path = settings.thumbs_dir / subdir / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    return FileResponse(file_path, media_type="image/jpeg")
