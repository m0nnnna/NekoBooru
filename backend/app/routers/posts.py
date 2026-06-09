from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, delete, insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..config import settings
from ..models import Post, Tag, TagCategory, TagAlias, TagImplication, Favorite
from ..models.post import PostTag
from ..utils.hashing import calculate_sha256
from ..services.media import get_media_info, create_thumbnail, move_to_storage, convert_video_to_gif
from ..services.search import search_posts
from ..services.tagging import normalize_tag
from ..services.tagging import process_tags_for_post as apply_tags_for_post
from ..services.tagging import replace_tags_for_post
from .uploads import get_upload_path, remove_upload_token

router = APIRouter(prefix="/api", tags=["posts"])


class CreatePostRequest(BaseModel):
    contentToken: str
    safety: str = "safe"
    tags: list[str] = []
    source: Optional[str] = None
    autoTag: Optional[bool] = None
    autoTagProfile: Optional[str] = None


class UpdatePostRequest(BaseModel):
    safety: Optional[str] = None
    tags: Optional[list[str]] = None
    source: Optional[str] = None


class SaveAiAnalysisRequest(BaseModel):
    suggestion: dict = {}
    settings: dict = {}
    profile: Optional[str] = None


class UpdateAiAnalysisRequest(BaseModel):
    description: str = ""


class BulkDeleteRequest(BaseModel):
    postIds: list[int]


class BulkUpdateRequest(BaseModel):
    postIds: list[int]
    tagMode: Optional[str] = None
    tags: list[str] = []
    safety: Optional[str] = None


async def _post_by_sha256(db: AsyncSession, sha256: str) -> Post | None:
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags), selectinload(Post.favorite))
        .where(Post.sha256 == sha256)
    )
    return result.scalars().first()


def _duplicate_post_exception(post: Post | None, sha256: str) -> HTTPException:
    if post:
        message = (
            "Same post detected. This content matches a deleted NekoBooru post."
            if post.deleted_at is not None
            else "Same post detected. This content already exists in NekoBooru."
        )
        return HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_post",
                "message": message,
                "post": post.to_dict(),
                "postId": post.id,
                "postUrl": f"/post/{post.id}",
                "sha256": sha256,
                "deleted": post.deleted_at is not None,
            },
        )
    return HTTPException(
        status_code=409,
        detail={
            "code": "duplicate_post",
            "message": "Same post detected, but the existing post could not be loaded. Refresh and try again.",
            "post": None,
            "postId": None,
            "postUrl": None,
            "sha256": sha256,
        },
    )


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
        existing_post = await _post_by_sha256(db, sha256)
        if existing_post:
            # Clean up temp file
            temp_path.unlink(missing_ok=True)
            remove_upload_token(request.contentToken)
            raise _duplicate_post_exception(existing_post, sha256)

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

        # Perceptual hash for near-duplicate / "find similar" search. Best-effort:
        # hashes the original for images, the just-made thumbnail for videos.
        from ..services.similarity import phash_for_media
        phash = phash_for_media(final_path, thumb_path, extension)

        # Optional auto-tagging runs after the file is in permanent storage so
        # library imports, URL fetches, and direct uploads all share one path.
        final_tags = list(request.tags or [])
        final_safety = request.safety
        auto_warning = None
        from ..services.auto_tagger import load_options
        opts = load_options()
        should_auto_tag = opts.tagNewUploads if request.autoTag is None else request.autoTag
        if should_auto_tag:
            from ..services.auto_tagger import merge_with_existing, promote_safety, tag_media
            auto_result = tag_media(final_path, opts)
            final_tags, auto_categories = merge_with_existing(final_tags, auto_result, opts)
            final_safety = promote_safety(final_safety, auto_result.safety, opts)
            # Surface a warning if tagging was requested but produced nothing due
            # to an error (e.g. the remote GPU worker was offline). The post is
            # still created normally — we just flag that it wasn't auto-tagged.
            if auto_result.error and not auto_result.all_tags:
                auto_warning = auto_result.error
        else:
            auto_categories = {}

        # Create post record
        post = Post(
            sha256=sha256,
            filename=temp_path.name,
            extension=extension,
            file_size=file_size,
            width=media_info.get("width"),
            height=media_info.get("height"),
            duration=media_info.get("duration"),
            safety=final_safety,
            source=request.source,
            phash=phash,
        )
        db.add(post)
        try:
            await db.flush()  # Get post ID
        except IntegrityError as exc:
            await db.rollback()
            if "posts.sha256" not in str(exc):
                raise
            existing_post = await _post_by_sha256(db, sha256)
            remove_upload_token(request.contentToken)
            raise _duplicate_post_exception(existing_post, sha256)

        # Process tags using direct inserts (avoids lazy loading issues)
        await apply_tags_for_post(db, post.id, final_tags, categories=auto_categories)
        if should_auto_tag and getattr(opts, "saveSemanticAnalysis", False):
            from ..services.ai_analysis import save_analysis_from_result

            await save_analysis_from_result(
                db,
                post.id,
                auto_result,
                opts=opts,
                profile=request.autoTagProfile or "upload",
            )

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
        response = post.to_dict()
        if auto_warning:
            response["autoTagWarning"] = auto_warning
        return response

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
    await apply_tags_for_post(db, post_id, tag_names)


@router.get("/posts")
async def list_posts(
    q: str = Query("", description="Search query"),
    page: int = Query(1, ge=1),
    limit: int = Query(42, ge=1, le=500),
    sort: str = Query("date"),
    order: str = Query("desc"),
    db: AsyncSession = Depends(get_db),
):
    """List posts with search and pagination."""
    from ..services.auto_tagger import load_options

    posts, total = await search_posts(db, q, page, limit, sort, order, semantic_search=load_options().semanticSearchEnabled)

    return {
        "results": [p.to_dict() for p in posts],
        "total": total,
        "page": page,
        "limit": limit,
        "pages": (total + limit - 1) // limit if limit > 0 else 0,
    }


@router.get("/posts/similarity/backfill")
async def get_similarity_backfill(db: AsyncSession = Depends(get_db)):
    """Status of the perceptual-hash backfill plus how many posts still need one."""
    from ..services.similarity import backfill_status, count_missing

    return {"job": backfill_status(), "missing": await count_missing(db)}


@router.post("/posts/similarity/backfill")
async def start_similarity_backfill():
    """Compute perceptual hashes for any posts missing one (older uploads)."""
    from ..services.similarity import start_backfill

    return start_backfill()


@router.get("/posts/duplicates")
async def list_duplicate_groups(db: AsyncSession = Depends(get_db)):
    """Groups of posts that share an identical perceptual hash (likely dupes)."""
    from sqlalchemy import func

    dup_hashes = (
        await db.execute(
            select(Post.phash)
            .where(Post.phash.is_not(None), Post.phash != "", Post.deleted_at.is_(None))
            .group_by(Post.phash)
            .having(func.count(Post.id) > 1)
        )
    ).scalars().all()
    if not dup_hashes:
        return {"groups": []}

    rows = (
        await db.execute(
            select(Post)
            .options(selectinload(Post.tags), selectinload(Post.favorite))
            .where(Post.phash.in_(dup_hashes), Post.deleted_at.is_(None))
            .order_by(Post.phash, Post.id)
        )
    ).scalars().all()
    groups: dict[str, list] = {}
    for post in rows:
        groups.setdefault(post.phash, []).append(post.to_dict())
    return {"groups": [{"phash": h, "posts": p} for h, p in groups.items() if len(p) > 1]}


@router.get("/posts/{post_id}/similar")
async def similar_posts(
    post_id: int,
    limit: int = Query(24, ge=1, le=100),
    max_distance: int = Query(12, ge=0, le=64),
    db: AsyncSession = Depends(get_db),
):
    """Posts visually similar to this one (perceptual-hash nearest neighbours)."""
    from ..services.similarity import find_similar

    return {"results": await find_similar(db, post_id, limit=limit, max_distance=max_distance)}


@router.get("/posts/{post_id}/neighbors")
async def post_neighbors(
    post_id: int,
    q: str = Query("", description="Search query (same syntax as the list)"),
    sort: str = Query("date"),
    order: str = Query("desc"),
    db: AsyncSession = Depends(get_db),
):
    """Prev/next post ids around this one within the given filtered/sorted view.

    Powers arrow-key and on-screen navigation between posts that obeys the
    current search and sort. Returns ``{"prev": id|null, "next": id|null}``.
    """
    from ..services.search import get_post_neighbors

    from ..services.auto_tagger import load_options

    return await get_post_neighbors(db, post_id, q, sort, order, semantic_search=load_options().semanticSearchEnabled)


@router.get("/posts/{post_id}")
async def get_post(post_id: int, db: AsyncSession = Depends(get_db)):
    """Get a single post by ID."""
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags), selectinload(Post.favorite))
        .where(Post.id == post_id)
    )
    post = result.scalars().first()

    if not post or post.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Post not found")

    return post.to_dict()


@router.get("/posts/{post_id}/ai-analysis")
async def get_post_ai_analysis(post_id: int, db: AsyncSession = Depends(get_db)):
    """Return saved semantic/Qwen analysis for a post."""
    result = await db.execute(select(Post.id).where(Post.id == post_id, Post.deleted_at.is_(None)))
    if not result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")
    from ..services.ai_analysis import list_post_analysis

    return {"postId": post_id, "results": await list_post_analysis(db, post_id)}


@router.post("/posts/{post_id}/ai-analysis")
async def save_post_ai_analysis(
    post_id: int,
    request: SaveAiAnalysisRequest,
    db: AsyncSession = Depends(get_db),
):
    """Persist Qwen semantic evidence from an AI preview for later search."""
    result = await db.execute(select(Post.id).where(Post.id == post_id, Post.deleted_at.is_(None)))
    if not result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")

    from ..services.ai_analysis import list_post_analysis, save_analysis_from_result
    from ..services.auto_tagger import load_options, validate_options

    opts = validate_options({**load_options().__dict__, **(request.settings or {})})
    saved = await save_analysis_from_result(
        db,
        post_id,
        request.suggestion or {},
        opts=opts,
        profile=request.profile or "post",
    )
    if saved:
        await db.commit()
    return {"postId": post_id, "saved": len(saved), "results": await list_post_analysis(db, post_id)}


@router.put("/posts/{post_id}/ai-analysis/{analysis_id}")
async def update_saved_post_ai_analysis(
    post_id: int,
    analysis_id: int,
    request: UpdateAiAnalysisRequest,
    db: AsyncSession = Depends(get_db),
):
    """Edit the saved semantic description for a post analysis."""
    result = await db.execute(select(Post.id).where(Post.id == post_id, Post.deleted_at.is_(None)))
    if not result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")

    from ..services.ai_analysis import update_post_analysis_description

    analysis = await update_post_analysis_description(db, post_id, analysis_id, request.description)
    if not analysis:
        raise HTTPException(status_code=404, detail="AI analysis not found")
    await db.commit()
    await db.refresh(analysis)
    return analysis.to_dict()


@router.delete("/posts/{post_id}/ai-analysis")
async def delete_saved_post_ai_analysis(post_id: int, db: AsyncSession = Depends(get_db)):
    """Remove saved semantic analysis for a post."""
    result = await db.execute(select(Post.id).where(Post.id == post_id, Post.deleted_at.is_(None)))
    if not result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")
    from ..services.ai_analysis import delete_post_analysis

    deleted = await delete_post_analysis(db, post_id)
    await db.commit()
    return {"postId": post_id, "deleted": deleted}


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
        await replace_tags_for_post(db, post, request.tags)

    # Touch updated_at so the change is recorded even when only tags changed
    # (tag associations are written via Core inserts that don't fire ORM events).
    from datetime import datetime
    post.updated_at = datetime.utcnow()

    await db.commit()

    # Reload for response
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags), selectinload(Post.favorite))
        .where(Post.id == post_id)
    )
    post = result.scalars().first()
    return post.to_dict()


@router.post("/posts/{post_id}/restore")
async def restore_post(post_id: int, db: AsyncSession = Depends(get_db)):
    """Restore a soft-deleted post so duplicate uploads can recover it."""
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags), selectinload(Post.favorite))
        .where(Post.id == post_id)
    )
    post = result.scalars().first()

    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    from datetime import datetime
    post.deleted_at = None
    post.updated_at = datetime.utcnow()
    await db.commit()

    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags), selectinload(Post.favorite))
        .where(Post.id == post_id)
    )
    post = result.scalars().first()
    return post.to_dict()


@router.post("/posts/{post_id}/auto-tags/preview")
async def preview_auto_tags(post_id: int, body: dict | None = None):
    """Preview AI tag suggestions for a single post without applying."""
    from ..services.auto_tag_jobs import preview_post
    body = body or {}
    try:
        return await preview_post(post_id, overrides=body.get("settings") or {})
    except ValueError:
        raise HTTPException(status_code=404, detail="Post not found")


@router.post("/posts/{post_id}/auto-tags/apply")
async def apply_auto_tags(post_id: int, body: dict | None = None):
    """Apply AI tag suggestions, or edited suggestions, to a single post."""
    from ..services.auto_tag_jobs import apply_post
    body = body or {}
    try:
        return await apply_post(
            post_id,
            tags=body.get("tags"),
            safety=body.get("safety"),
            categories=body.get("categories") or {},
            overrides=body.get("settings") or {},
            suggestion=body.get("suggestion") or {},
            save_analysis=body.get("saveAnalysis") is True,
            profile=body.get("profile") or "post",
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Post not found")


@router.delete("/posts/{post_id}")
async def delete_post(post_id: int, db: AsyncSession = Depends(get_db)):
    """Soft-delete a post.

    The row and its files are kept (marked with ``deleted_at``) so the deletion
    can propagate as a tombstone through the sync change log. A separate purge
    step can reclaim disk space later. Soft-deleted posts are hidden from search.
    """
    from datetime import datetime

    result = await db.execute(
        select(Post).where(Post.id == post_id)
    )
    post = result.scalars().first()

    if not post or post.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Post not found")

    post.deleted_at = datetime.utcnow()
    await db.commit()

    return {"success": True}


@router.post("/posts/bulk-delete")
async def bulk_delete_posts(request: BulkDeleteRequest, db: AsyncSession = Depends(get_db)):
    """Soft-delete many posts in one transaction (multi-select editing).

    Mirrors :func:`delete_post`: each row is marked with ``deleted_at`` (kept for
    sync tombstones), committed together so the change log captures every one.
    """
    from datetime import datetime

    if not request.postIds:
        return {"deleted": 0}

    result = await db.execute(
        select(Post).where(Post.id.in_(request.postIds), Post.deleted_at.is_(None))
    )
    posts = list(result.scalars().all())
    now = datetime.utcnow()
    for post in posts:
        post.deleted_at = now
    await db.commit()
    return {"deleted": len(posts)}


@router.post("/posts/bulk-update")
async def bulk_update_posts(request: BulkUpdateRequest, db: AsyncSession = Depends(get_db)):
    """Apply scoped batch edits to selected posts.

    Supported tag modes:
    - add: append tags, preserving existing tags
    - remove: remove listed tags
    - replace: replace the full tag set with the listed tags
    - clear: remove every tag
    """
    from datetime import datetime

    if not request.postIds:
        return {"updated": 0}

    tag_mode = (request.tagMode or "").strip().lower()
    if tag_mode and tag_mode not in {"add", "remove", "replace", "clear"}:
        raise HTTPException(status_code=400, detail="Unsupported tag mode")
    if request.safety is not None and request.safety not in {"safe", "sketchy", "unsafe"}:
        raise HTTPException(status_code=400, detail="Unsupported safety rating")

    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags))
        .where(Post.id.in_(request.postIds), Post.deleted_at.is_(None))
    )
    posts = list(result.scalars().all())
    incoming_tags = [tag for tag in (normalize_tag(raw) for raw in request.tags) if tag]
    incoming_set = set(incoming_tags)
    now = datetime.utcnow()

    for post in posts:
        if tag_mode:
            existing_tags = [tag.name for tag in (post.tags or [])]
            if tag_mode == "add":
                next_tags = list(dict.fromkeys([*existing_tags, *incoming_tags]))
            elif tag_mode == "remove":
                next_tags = [tag for tag in existing_tags if normalize_tag(tag) not in incoming_set]
            elif tag_mode == "replace":
                next_tags = incoming_tags
            else:
                next_tags = []
            await replace_tags_for_post(db, post, next_tags)
        if request.safety is not None:
            post.safety = request.safety
            post.updated_at = now

    await db.commit()
    return {"updated": len(posts)}


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
async def serve_post_media(subdir: str, filename: str, format: Optional[str] = None):
    """Serve original post media files.

    Pass ``?format=gif`` on a video (mp4/webm) to download an animated GIF
    transcoded from the video. The conversion is cached so repeat requests are
    cheap. The stored file is never modified.
    """
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
async def serve_thumbnail(subdir: str, filename: str):
    """Serve thumbnail files."""
    file_path = settings.thumbs_dir / subdir / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    return FileResponse(file_path, media_type="image/jpeg")
