from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, delete, insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..config import settings
from ..models import Post, Tag, TagCategory, TagAlias, TagImplication, Favorite
from ..models.post import PostTag
from ..utils.hashing import calculate_sha256
from ..services.media import get_media_info, create_thumbnail, move_to_storage
from ..services.search import search_posts
from .uploads import get_upload_path, remove_upload_token

router = APIRouter(prefix="/api", tags=["posts"])


class CreatePostRequest(BaseModel):
    contentToken: str
    safety: str = "safe"
    tags: list[str] = []
    source: Optional[str] = None


class UpdatePostRequest(BaseModel):
    safety: Optional[str] = None
    tags: Optional[list[str]] = None
    source: Optional[str] = None


@router.post("/posts")
async def create_post(request: CreatePostRequest, db: AsyncSession = Depends(get_db)):
    """
    Create a new post from an uploaded file.
    Compatible with szurubooru API.
    """
    # Get the uploaded file
    temp_path = get_upload_path(request.contentToken)
    if not temp_path or not temp_path.exists():
        raise HTTPException(status_code=400, detail="Invalid or expired content token")

    try:
        # Calculate file hash
        sha256 = calculate_sha256(temp_path)

        # Check for duplicate
        existing = await db.execute(select(Post).where(Post.sha256 == sha256))
        if existing.scalars().first():
            # Clean up temp file
            temp_path.unlink(missing_ok=True)
            remove_upload_token(request.contentToken)
            raise HTTPException(status_code=409, detail="Post with this content already exists")

        # Get file info
        extension = temp_path.suffix.lower()
        file_size = temp_path.stat().st_size
        media_info = get_media_info(temp_path, extension)

        # Move to permanent storage
        final_path = move_to_storage(temp_path, sha256, extension)

        # Create thumbnail
        thumb_subdir = settings.thumbs_dir / sha256[:2]
        thumb_path = thumb_subdir / f"{sha256}.jpg"
        thumbnail_created = create_thumbnail(final_path, thumb_path, extension)
        if not thumbnail_created:
            # Log warning but don't fail the upload
            import logging
            logger = logging.getLogger(__name__)
            logger.warning(f"Failed to create thumbnail for {final_path} (extension: {extension})")

        # Create post record
        post = Post(
            sha256=sha256,
            filename=temp_path.name,
            extension=extension,
            file_size=file_size,
            width=media_info.get("width"),
            height=media_info.get("height"),
            duration=media_info.get("duration"),
            safety=request.safety,
            source=request.source,
        )
        db.add(post)
        await db.flush()  # Get post ID

        # Process tags using direct inserts (avoids lazy loading issues)
        await process_tags_for_post(db, post.id, request.tags)

        await db.commit()

        # Clean up token
        remove_upload_token(request.contentToken)

        # Reload with relationships for response
        result = await db.execute(
            select(Post)
            .options(selectinload(Post.tags), selectinload(Post.favorite))
            .where(Post.id == post.id)
        )
        post = result.scalars().first()
        return post.to_dict()

    except HTTPException:
        raise
    except Exception as e:
        # Clean up on error
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)
        remove_upload_token(request.contentToken)
        raise HTTPException(status_code=500, detail=str(e))


async def process_tags_for_post(db: AsyncSession, post_id: int, tag_names: list[str]):
    """Process tags for a post using direct SQL inserts to avoid async issues."""
    if not tag_names:
        return

    resolved_tag_ids = set()

    # Get default category
    default_cat = await db.execute(select(TagCategory).where(TagCategory.name == "general"))
    default_category = default_cat.scalars().first()
    default_cat_id = default_category.id if default_category else 1

    for tag_name in tag_names:
        tag_name = tag_name.strip().lower().replace(" ", "_")
        if not tag_name:
            continue

        # Check for alias
        alias_result = await db.execute(
            select(TagAlias).options(selectinload(TagAlias.target)).where(TagAlias.alias_name == tag_name)
        )
        alias = alias_result.scalars().first()
        if alias and alias.target:
            tag_name = alias.target.name

        # Get or create tag
        tag_result = await db.execute(select(Tag).where(Tag.name == tag_name))
        tag = tag_result.scalars().first()

        if not tag:
            tag = Tag(name=tag_name, category_id=default_cat_id)
            db.add(tag)
            await db.flush()

        resolved_tag_ids.add(tag.id)

        # Get implications
        impl_result = await db.execute(
            select(TagImplication).where(TagImplication.antecedent_id == tag.id)
        )
        for impl in impl_result.scalars().all():
            resolved_tag_ids.add(impl.consequent_id)

    # Insert all tag associations using direct SQL
    for tag_id in resolved_tag_ids:
        # Check if association already exists
        existing = await db.execute(
            select(PostTag).where(
                PostTag.c.post_id == post_id,
                PostTag.c.tag_id == tag_id
            )
        )
        if not existing.first():
            await db.execute(
                insert(PostTag).values(post_id=post_id, tag_id=tag_id)
            )
            # Update usage count
            await db.execute(
                Tag.__table__.update().where(Tag.id == tag_id).values(
                    usage_count=Tag.usage_count + 1
                )
            )


@router.get("/posts")
async def list_posts(
    q: str = Query("", description="Search query"),
    page: int = Query(1, ge=1),
    limit: int = Query(40, ge=1, le=100),
    sort: str = Query("date"),
    order: str = Query("desc"),
    db: AsyncSession = Depends(get_db),
):
    """List posts with search and pagination."""
    posts, total = await search_posts(db, q, page, limit, sort, order)

    return {
        "results": [p.to_dict() for p in posts],
        "total": total,
        "page": page,
        "limit": limit,
        "pages": (total + limit - 1) // limit if limit > 0 else 0,
    }


@router.get("/posts/{post_id}")
async def get_post(post_id: int, db: AsyncSession = Depends(get_db)):
    """Get a single post by ID."""
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags), selectinload(Post.favorite))
        .where(Post.id == post_id)
    )
    post = result.scalars().first()

    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    return post.to_dict()


@router.put("/posts/{post_id}")
async def update_post(post_id: int, request: UpdatePostRequest, db: AsyncSession = Depends(get_db)):
    """Update a post."""
    result = await db.execute(
        select(Post).options(selectinload(Post.tags)).where(Post.id == post_id)
    )
    post = result.scalars().first()

    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    if request.safety is not None:
        post.safety = request.safety

    if request.source is not None:
        post.source = request.source

    if request.tags is not None:
        # Decrement old tag counts
        for tag in post.tags:
            tag.usage_count = max(0, tag.usage_count - 1)

        # Delete existing tag associations
        await db.execute(
            delete(PostTag).where(PostTag.c.post_id == post_id)
        )

        # Process new tags
        await process_tags_for_post(db, post_id, request.tags)

    await db.commit()

    # Reload for response
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags), selectinload(Post.favorite))
        .where(Post.id == post_id)
    )
    post = result.scalars().first()
    return post.to_dict()


@router.delete("/posts/{post_id}")
async def delete_post(post_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a post and its files."""
    result = await db.execute(
        select(Post).options(selectinload(Post.tags)).where(Post.id == post_id)
    )
    post = result.scalars().first()

    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    # Delete files
    content_path = settings.posts_dir / post.sha256[:2] / f"{post.sha256}{post.extension}"
    thumb_path = settings.thumbs_dir / post.sha256[:2] / f"{post.sha256}.jpg"

    content_path.unlink(missing_ok=True)
    thumb_path.unlink(missing_ok=True)

    # Decrement tag counts
    for tag in post.tags:
        tag.usage_count = max(0, tag.usage_count - 1)

    # Delete post
    await db.delete(post)
    await db.commit()

    return {"success": True}


@router.post("/posts/{post_id}/favorite")
async def toggle_favorite(post_id: int, db: AsyncSession = Depends(get_db)):
    """Toggle favorite status on a post."""
    result = await db.execute(
        select(Post).options(selectinload(Post.favorite)).where(Post.id == post_id)
    )
    post = result.scalars().first()

    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    if post.favorite:
        await db.delete(post.favorite)
        is_favorited = False
    else:
        fav = Favorite(post_id=post_id)
        db.add(fav)
        is_favorited = True

    await db.commit()
    return {"isFavorited": is_favorited}


# Media serving routes
@router.get("/media/posts/{subdir}/{filename}")
async def serve_post_media(subdir: str, filename: str):
    """Serve original post media files."""
    file_path = settings.posts_dir / subdir / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Determine media type
    ext = Path(filename).suffix.lower()
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
async def serve_thumbnail(subdir: str, filename: str):
    """Serve thumbnail files."""
    file_path = settings.thumbs_dir / subdir / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    return FileResponse(file_path, media_type="image/jpeg")
