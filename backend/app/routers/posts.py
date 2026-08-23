from pathlib import Path
from typing import Optional, Callable, Literal
import asyncio
import shutil
import threading
import time
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, delete, insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db, async_session
from ..config import settings
from ..dependencies import get_current_user
from ..models import Post, Tag, TagCategory, TagAlias, TagImplication, Favorite, User
from ..models.post import PostTag
from ..services.auth import visible_owner_ids
from ..utils.hashing import calculate_sha256
from ..services.media import (
    get_media_info,
    create_thumbnail,
    move_to_storage,
    convert_video_to_gif,
    optimize_media_to_temp,
)
from ..services.search import search_posts
from ..services.tagging import normalize_tag
from ..services.tagging import process_tags_for_post as apply_tags_for_post
from ..services.tagging import replace_tags_for_post
from .uploads import get_upload_path, remove_upload_token

router = APIRouter(prefix="/api", tags=["posts"])

_optimize_jobs_lock = threading.Lock()
_optimize_jobs: dict[str, dict] = {}
_optimize_previews_lock = threading.Lock()
_optimize_previews: dict[str, dict] = {}
_OPTIMIZE_PREVIEW_TTL_SECONDS = 60 * 60


class CreatePostRequest(BaseModel):
    contentToken: str
    safety: str = "safe"
    tags: list[str] = []
    source: Optional[str] = None
    autoTag: Optional[bool] = None
    autoTagProfile: Optional[str] = None
    # Tag metadata the client already knows, e.g. the browser extension
    # importing a booru post's own artist/character/copyright split. Keyed by
    # tag name; anything absent falls back to "general" as before.
    tagCategories: dict[str, str] = {}
    tagDisplayNames: dict[str, str] = {}


class UpdatePostRequest(BaseModel):
    safety: Optional[str] = None
    tags: Optional[list[str]] = None
    source: Optional[str] = None
    # As on create: the category/spelling a client already knows, e.g. a tag
    # picked from a remote booru suggestion that this library has never seen.
    tagCategories: dict[str, str] = {}
    tagDisplayNames: dict[str, str] = {}


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


class BulkOptimizeMediaRequest(BaseModel):
    postIds: list[int]
    imageMaxDimension: Optional[int] = None
    imageQuality: int = 85
    videoMaxDimension: Optional[int] = None
    videoBitrateKbps: Optional[int] = None
    socialCompatible: bool = False
    preview: bool = False
    previewIds: dict[int, str] = Field(default_factory=dict)
    applyMode: Literal["replace", "create"] = "replace"


async def _post_by_sha256(db: AsyncSession, sha256: str, owner_ids: list[int] | None = None) -> Post | None:
    stmt = (
        select(Post)
        .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
        .where(Post.sha256 == sha256)
    )
    if owner_ids is not None:
        stmt = stmt.where(Post.owner_id.in_(owner_ids))
    result = await db.execute(stmt)
    return result.scalars().first()


def _duplicate_post_exception(
    post: Post | None, sha256: str, current_user_id: int | None = None, visible: bool = True
) -> HTTPException:
    if post and visible:
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
                "post": post.to_dict(current_user_id),
                "postId": post.id,
                "postUrl": f"/post/{post.id}",
                "sha256": sha256,
                "deleted": post.deleted_at is not None,
            },
        )
    # The sha256 collided with a post that isn't visible to this user - a
    # different user already has this exact file in their own (private)
    # library. Don't leak that post's id, tags, or thumbnail; each library is
    # supposed to be independent, so this user simply can't have their own
    # copy of a file another library already claimed by content hash.
    message = (
        "This exact file already exists in another user's library. Each library "
        "keeps its own content, so it can't be uploaded again here."
        if post is not None
        else "Same post detected, but the existing post could not be loaded. Refresh and try again."
    )
    return HTTPException(
        status_code=409,
        detail={
            "code": "duplicate_post",
            "message": message,
            "post": None,
            "postId": None,
            "postUrl": None,
            "sha256": sha256,
        },
    )


@router.post("/posts")
async def create_post(
    request: CreatePostRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Create a new post from an uploaded file.
    Compatible with szurubooru API.
    """
    # Captured up front: a rollback later in this function (duplicate-sha256
    # IntegrityError) expires every ORM object on this session, including
    # current_user, and touching current_user.id afterwards would trigger a
    # synchronous lazy-refresh outside any await - MissingGreenlet. A plain
    # int has no such lifecycle.
    current_user_id = current_user.id

    # Get the uploaded file
    temp_path = get_upload_path(request.contentToken)
    if not temp_path or not temp_path.exists():
        raise HTTPException(status_code=400, detail="Invalid or expired content token")

    owner_ids = await visible_owner_ids(db, current_user)

    try:
        # Calculate file hash
        sha256 = calculate_sha256(temp_path)

        # Check for duplicate within what this user can see
        existing_post = await _post_by_sha256(db, sha256, owner_ids=owner_ids)
        if existing_post:
            # Clean up temp file
            temp_path.unlink(missing_ok=True)
            remove_upload_token(request.contentToken)
            raise _duplicate_post_exception(existing_post, sha256, current_user_id)

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
            auto_display_names = dict(auto_result.display_names)
            final_safety = promote_safety(final_safety, auto_result.safety, opts)
            # Surface a warning if tagging was requested but produced nothing due
            # to an error (e.g. the remote GPU worker was offline). The post is
            # still created normally — we just flag that it wasn't auto-tagged.
            if auto_result.error and not auto_result.all_tags:
                auto_warning = auto_result.error
        else:
            auto_categories = {}
            auto_display_names = {}

        # Create post record
        post = Post(
            owner_id=current_user_id,
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
            # sha256 is globally unique, so this collided with a post that
            # exists but wasn't in this user's visible set above - i.e. it
            # belongs to another user's library. Don't expose its details.
            existing_post = await _post_by_sha256(db, sha256)
            remove_upload_token(request.contentToken)
            raise _duplicate_post_exception(existing_post, sha256, current_user_id, visible=False)

        # Process tags using direct inserts (avoids lazy loading issues).
        # A category the client supplied comes from the source site's own
        # taxonomy, so it outranks what the local models inferred.
        await apply_tags_for_post(
            db,
            post.id,
            final_tags,
            categories={**auto_categories, **(request.tagCategories or {})},
            display_names={**auto_display_names, **(request.tagDisplayNames or {})},
        )
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
            .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
            .where(Post.id == post.id)
        )
        post = result.scalars().first()
        response = post.to_dict(current_user_id)
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
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List posts with search and pagination."""
    from ..services.auto_tagger import load_options

    owner_ids = await visible_owner_ids(db, current_user)
    posts, total = await search_posts(
        db, q, page, limit, sort, order,
        semantic_search=load_options().semanticSearchEnabled,
        owner_ids=owner_ids,
        current_user_id=current_user.id,
    )

    return {
        "results": [p.to_dict(current_user.id) for p in posts],
        "total": total,
        "page": page,
        "limit": limit,
        "pages": (total + limit - 1) // limit if limit > 0 else 0,
    }


@router.get("/posts/similarity/backfill")
async def get_similarity_backfill(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Status of the perceptual-hash backfill plus how many posts still need one."""
    from ..services.similarity import backfill_status, count_missing

    return {"job": backfill_status(), "missing": await count_missing(db)}


@router.post("/posts/similarity/backfill")
async def start_similarity_backfill(current_user: User = Depends(get_current_user)):
    """Compute perceptual hashes for any posts missing one (older uploads)."""
    from ..services.similarity import start_backfill

    return start_backfill()


@router.get("/posts/duplicates")
async def list_duplicate_groups(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Groups of posts that share an identical perceptual hash (likely dupes)."""
    from sqlalchemy import func

    owner_ids = await visible_owner_ids(db, current_user)

    dup_hashes = (
        await db.execute(
            select(Post.phash)
            .where(
                Post.phash.is_not(None), Post.phash != "", Post.deleted_at.is_(None),
                Post.owner_id.in_(owner_ids),
            )
            .group_by(Post.phash)
            .having(func.count(Post.id) > 1)
        )
    ).scalars().all()
    if not dup_hashes:
        return {"groups": []}

    rows = (
        await db.execute(
            select(Post)
            .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
            .where(
                Post.phash.in_(dup_hashes), Post.deleted_at.is_(None),
                Post.owner_id.in_(owner_ids),
            )
            .order_by(Post.phash, Post.id)
        )
    ).scalars().all()
    groups: dict[str, list] = {}
    for post in rows:
        groups.setdefault(post.phash, []).append(post.to_dict(current_user.id))
    return {"groups": [{"phash": h, "posts": p} for h, p in groups.items() if len(p) > 1]}


@router.get("/posts/{post_id}/similar")
async def similar_posts(
    post_id: int,
    limit: int = Query(24, ge=1, le=100),
    max_distance: int = Query(12, ge=0, le=64),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Posts visually similar to this one (perceptual-hash nearest neighbours)."""
    from ..services.similarity import find_similar

    owner_ids = await visible_owner_ids(db, current_user)
    return {
        "results": await find_similar(
            db, post_id, limit=limit, max_distance=max_distance,
            owner_ids=owner_ids, current_user_id=current_user.id,
        )
    }


@router.get("/posts/{post_id}/neighbors")
async def post_neighbors(
    post_id: int,
    q: str = Query("", description="Search query (same syntax as the list)"),
    sort: str = Query("date"),
    order: str = Query("desc"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Prev/next post ids around this one within the given filtered/sorted view.

    Powers arrow-key and on-screen navigation between posts that obeys the
    current search and sort. Returns ``{"prev": id|null, "next": id|null}``.
    """
    from ..services.search import get_post_neighbors

    from ..services.auto_tagger import load_options

    owner_ids = await visible_owner_ids(db, current_user)
    return await get_post_neighbors(
        db, post_id, q, sort, order,
        semantic_search=load_options().semanticSearchEnabled,
        owner_ids=owner_ids,
        current_user_id=current_user.id,
    )


@router.get("/posts/{post_id}")
async def get_post(post_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get a single post by ID."""
    owner_ids = await visible_owner_ids(db, current_user)
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
        .where(Post.id == post_id, Post.owner_id.in_(owner_ids))
    )
    post = result.scalars().first()

    if not post or post.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Post not found")

    return post.to_dict(current_user.id)


@router.get("/posts/{post_id}/online-matches")
async def get_post_online_matches(
    post_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Look for byte-exact copies without uploading the post anywhere."""
    owner_ids = await visible_owner_ids(db, current_user)
    result = await db.execute(
        select(Post).where(Post.id == post_id, Post.deleted_at.is_(None), Post.owner_id.in_(owner_ids))
    )
    post = result.scalars().first()
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    file_path = settings.posts_dir / post.content_path
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Post file not found")

    from ..services.online_image_search import find_exact_online_matches

    return await find_exact_online_matches(file_path)


@router.get("/posts/{post_id}/ai-analysis")
async def get_post_ai_analysis(
    post_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Return saved semantic/Qwen analysis for a post."""
    owner_ids = await visible_owner_ids(db, current_user)
    result = await db.execute(
        select(Post.id).where(Post.id == post_id, Post.deleted_at.is_(None), Post.owner_id.in_(owner_ids))
    )
    if not result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")
    from ..services.ai_analysis import list_post_analysis

    return {"postId": post_id, "results": await list_post_analysis(db, post_id)}


@router.post("/posts/{post_id}/ai-analysis")
async def save_post_ai_analysis(
    post_id: int,
    request: SaveAiAnalysisRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Persist Qwen semantic evidence from an AI preview for later search."""
    result = await db.execute(
        select(Post.id).where(Post.id == post_id, Post.deleted_at.is_(None), Post.owner_id == current_user.id)
    )
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
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Edit the saved semantic description for a post analysis."""
    result = await db.execute(
        select(Post.id).where(Post.id == post_id, Post.deleted_at.is_(None), Post.owner_id == current_user.id)
    )
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
async def delete_saved_post_ai_analysis(
    post_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Remove saved semantic analysis for a post."""
    result = await db.execute(
        select(Post.id).where(Post.id == post_id, Post.deleted_at.is_(None), Post.owner_id == current_user.id)
    )
    if not result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")
    from ..services.ai_analysis import delete_post_analysis

    deleted = await delete_post_analysis(db, post_id)
    await db.commit()
    return {"postId": post_id, "deleted": deleted}


@router.put("/posts/{post_id}")
async def update_post(
    post_id: int,
    request: UpdatePostRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update a post."""
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags).selectinload(Tag.category))
        .where(Post.id == post_id, Post.owner_id == current_user.id)
    )
    post = result.scalars().first()

    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    if request.safety is not None:
        post.safety = request.safety

    if request.source is not None:
        post.source = request.source

    if request.tags is not None:
        await replace_tags_for_post(
            db,
            post,
            request.tags,
            categories=request.tagCategories or None,
            display_names=request.tagDisplayNames or None,
        )

    # Touch updated_at so the change is recorded even when only tags changed
    # (tag associations are written via Core inserts that don't fire ORM events).
    from datetime import datetime
    post.updated_at = datetime.utcnow()

    await db.commit()

    # Reload for response
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
        .where(Post.id == post_id)
    )
    post = result.scalars().first()
    return post.to_dict(current_user.id)


@router.post("/posts/{post_id}/restore")
async def restore_post(
    post_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Restore a soft-deleted post so duplicate uploads can recover it."""
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
        .where(Post.id == post_id, Post.owner_id == current_user.id)
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
        .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
        .where(Post.id == post_id)
    )
    post = result.scalars().first()
    return post.to_dict(current_user.id)


async def _require_own_post(post_id: int, current_user: User) -> None:
    # A short-lived session of its own, not the request's Depends(get_db)
    # session: preview_post/apply_post below open their own separate
    # connection to do their actual work, and holding this request's session
    # open with an uncommitted read transaction while that second connection
    # tries to write causes "database is locked" on SQLite.
    async with async_session() as session:
        result = await session.execute(
            select(Post.id).where(Post.id == post_id, Post.owner_id == current_user.id, Post.deleted_at.is_(None))
        )
        if not result.scalars().first():
            raise HTTPException(status_code=404, detail="Post not found")


@router.post("/posts/{post_id}/auto-tags/preview")
async def preview_auto_tags(
    post_id: int,
    body: dict | None = None,
    current_user: User = Depends(get_current_user),
):
    """Preview AI tag suggestions for a single post without applying."""
    from ..services.auto_tag_jobs import preview_post
    await _require_own_post(post_id, current_user)
    body = body or {}
    try:
        return await preview_post(post_id, overrides=body.get("settings") or {})
    except ValueError:
        raise HTTPException(status_code=404, detail="Post not found")


@router.post("/posts/{post_id}/auto-tags/apply")
async def apply_auto_tags(
    post_id: int,
    body: dict | None = None,
    current_user: User = Depends(get_current_user),
):
    """Apply AI tag suggestions, or edited suggestions, to a single post."""
    from ..services.auto_tag_jobs import apply_post
    await _require_own_post(post_id, current_user)
    body = body or {}
    try:
        return await apply_post(
            post_id,
            tags=body.get("tags"),
            safety=body.get("safety"),
            categories=body.get("categories") or {},
            display_names=body.get("displayNames") or {},
            overrides=body.get("settings") or {},
            suggestion=body.get("suggestion") or {},
            save_analysis=body.get("saveAnalysis") is True,
            profile=body.get("profile") or "post",
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Post not found")


@router.delete("/posts/{post_id}")
async def delete_post(
    post_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Soft-delete a post.

    The row and its files are kept (marked with ``deleted_at``) so the deletion
    can propagate as a tombstone through the sync change log. A separate purge
    step can reclaim disk space later. Soft-deleted posts are hidden from search.
    """
    from datetime import datetime

    result = await db.execute(
        select(Post).where(Post.id == post_id, Post.owner_id == current_user.id)
    )
    post = result.scalars().first()

    if not post or post.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Post not found")

    post.deleted_at = datetime.utcnow()
    await db.commit()

    return {"success": True}


@router.post("/posts/bulk-delete")
async def bulk_delete_posts(
    request: BulkDeleteRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete many posts in one transaction (multi-select editing).

    Mirrors :func:`delete_post`: each row is marked with ``deleted_at`` (kept for
    sync tombstones), committed together so the change log captures every one.
    """
    from datetime import datetime

    if not request.postIds:
        return {"deleted": 0}

    result = await db.execute(
        select(Post).where(
            Post.id.in_(request.postIds), Post.deleted_at.is_(None), Post.owner_id == current_user.id
        )
    )
    posts = list(result.scalars().all())
    now = datetime.utcnow()
    for post in posts:
        post.deleted_at = now
    await db.commit()
    return {"deleted": len(posts)}


@router.post("/posts/bulk-update")
async def bulk_update_posts(
    request: BulkUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
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
        .options(selectinload(Post.tags).selectinload(Tag.category))
        .where(
            Post.id.in_(request.postIds), Post.deleted_at.is_(None), Post.owner_id == current_user.id
        )
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


@router.post("/posts/bulk-optimize")
async def bulk_optimize_posts(
    request: BulkOptimizeMediaRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _bulk_optimize_posts_impl(request, db, owner_id=current_user.id)


@router.post("/posts/optimize-jobs")
async def start_optimize_job(request: BulkOptimizeMediaRequest, current_user: User = Depends(get_current_user)):
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "ownerId": current_user.id,
        "status": "queued",
        "progress": 0,
        "message": "Queued media optimization",
        "preview": request.preview,
        "processed": 0,
        "optimized": 0,
        "skipped": 0,
        "failed": 0,
        "results": [],
    }
    with _optimize_jobs_lock:
        _optimize_jobs[job_id] = job
    thread = threading.Thread(
        target=_run_optimize_job_thread, args=(job_id, request, current_user.id), daemon=True
    )
    thread.start()
    return job


@router.get("/posts/optimize-jobs/{job_id}")
async def get_optimize_job(job_id: str, current_user: User = Depends(get_current_user)):
    with _optimize_jobs_lock:
        job = _optimize_jobs.get(job_id)
        if not job or job.get("ownerId") != current_user.id:
            raise HTTPException(status_code=404, detail="Optimize job not found")
        return dict(job)


def _set_optimize_job(job_id: str, **updates):
    with _optimize_jobs_lock:
        job = _optimize_jobs.get(job_id)
        if not job:
            return
        job.update(updates)


def _cleanup_optimize_previews():
    now = time.time()
    stale_paths = []
    with _optimize_previews_lock:
        for preview_id, preview in list(_optimize_previews.items()):
            if preview["expiresAt"] <= now or not preview["path"].exists():
                stale_paths.append(preview["path"])
                _optimize_previews.pop(preview_id, None)
    for path in stale_paths:
        path.unlink(missing_ok=True)
    preview_dir = settings.cache_dir / "optimize-previews"
    if preview_dir.exists():
        for path in preview_dir.iterdir():
            try:
                if path.is_file() and path.stat().st_mtime <= now - _OPTIMIZE_PREVIEW_TTL_SECONDS:
                    path.unlink(missing_ok=True)
            except OSError:
                continue


def _store_optimize_preview(
    source: Path,
    output_extension: str,
    *,
    post_id: int,
    source_sha256: str,
    source_extension: str,
    output_sha256: str,
    compatibility: str | None = None,
) -> tuple[str, str]:
    _cleanup_optimize_previews()
    preview_id = uuid.uuid4().hex
    preview_dir = settings.cache_dir / "optimize-previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_path = preview_dir / f"{preview_id}{output_extension.lower()}"
    shutil.move(str(source), str(preview_path))
    with _optimize_previews_lock:
        _optimize_previews[preview_id] = {
            "path": preview_path,
            "extension": output_extension.lower(),
            "expiresAt": time.time() + _OPTIMIZE_PREVIEW_TTL_SECONDS,
            "postId": post_id,
            "sourceSha256": source_sha256,
            "sourceExtension": source_extension.lower(),
            "outputSha256": output_sha256,
            "compatibility": compatibility,
        }
    return preview_id, f"/api/posts/optimize-previews/{preview_id}"


def _claim_optimize_preview(
    preview_id: str,
    post: Post,
    required_compatibility: str | None = None,
) -> dict:
    """Atomically claim the exact reviewed artifact for replacement."""
    _cleanup_optimize_previews()
    with _optimize_previews_lock:
        preview = _optimize_previews.get(preview_id)
        if not preview:
            raise ValueError("reviewed preview expired; generate a new preview")
        if preview["postId"] != post.id:
            raise ValueError("reviewed preview does not belong to this post")
        if preview["sourceSha256"] != post.sha256:
            raise ValueError("post changed after preview; generate a new preview")
        if preview["sourceExtension"] != post.extension.lower():
            raise ValueError("post format changed after preview; generate a new preview")
        if preview.get("compatibility") != required_compatibility:
            raise ValueError("reviewed preview mode no longer matches the requested operation")
        preview_path = Path(preview["path"])
        if not preview_path.exists():
            _optimize_previews.pop(preview_id, None)
            raise ValueError("reviewed preview file is missing")
        _optimize_previews.pop(preview_id, None)
    return {**preview, "path": preview_path}


def _run_optimize_job_thread(job_id: str, request: BulkOptimizeMediaRequest, owner_id: int):
    async def runner():
        _set_optimize_job(job_id, status="running", progress=2, message="Starting media optimization")

        def progress(percent: int, message: str):
            _set_optimize_job(job_id, progress=max(0, min(99, int(percent))), message=message)

        try:
            async with async_session() as session:
                result = await _bulk_optimize_posts_impl(request, session, owner_id=owner_id, progress=progress)
                await session.commit()
            _set_optimize_job(
                job_id,
                **result,
                status="completed",
                progress=100,
                message=(
                    f"Preview ready: {result['optimized']} would change, {result['skipped']} skipped, {result['failed']} failed"
                    if request.preview else (
                        f"Created {result['optimized']} post copy/copies, skipped {result['skipped']}, failed {result['failed']}"
                        if request.applyMode == "create" else
                        f"Optimized {result['optimized']} post(s), skipped {result['skipped']}, failed {result['failed']}"
                    )
                ),
            )
        except Exception as exc:
            _set_optimize_job(job_id, status="failed", progress=100, message=str(exc), error=str(exc))

    asyncio.run(runner())


async def _bulk_optimize_posts_impl(
    request: BulkOptimizeMediaRequest,
    db: AsyncSession,
    owner_id: int,
    progress: Callable[[int, str], None] | None = None,
):
    """Resize/re-encode selected post media and rewrite metadata.

    This replaces stored originals only after an optimized temp file succeeds,
    then regenerates thumbnail/media metadata for the new content hash.
    """
    from datetime import datetime
    import logging
    from ..services.similarity import phash_for_media

    logger = logging.getLogger(__name__)

    if not request.postIds:
        return {
            "processed": 0,
            "optimized": 0,
            "skipped": 0,
            "failed": 0,
            "preview": request.preview,
            "socialCompatible": request.socialCompatible,
            "applyMode": request.applyMode,
            "results": [],
        }

    image_quality = max(1, min(100, int(request.imageQuality or 85)))
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
        .where(Post.id.in_(request.postIds), Post.deleted_at.is_(None), Post.owner_id == owner_id)
    )
    posts = list(result.scalars().all())
    results = []
    optimized = 0
    skipped = 0
    failed = 0

    total_posts = max(1, len(posts))
    for index, post in enumerate(posts):
        item_base_progress = int((index / total_posts) * 92) + 4
        item_span = max(1, int(92 / total_posts))
        if progress:
            progress(item_base_progress, f"Preparing post #{post.id} ({index + 1} / {len(posts)})")
        old_sha = post.sha256
        old_extension = post.extension.lower()
        old_file_size = post.file_size
        old_file_path = settings.posts_dir / post.content_path
        old_thumb_path = settings.thumbs_dir / post.thumb_path
        if not old_file_path.exists():
            failed += 1
            results.append({"postId": post.id, "status": "failed", "message": "stored file is missing"})
            continue

        social_video = request.socialCompatible and old_extension in {".mp4", ".webm"}
        if request.socialCompatible and not social_video:
            skipped += 1
            results.append({
                "postId": post.id,
                "status": "skipped",
                "message": "Social / X compatibility applies to videos only",
                "extension": post.extension,
                "oldSize": old_file_size,
                "newSize": old_file_size,
                "oldWidth": post.width,
                "oldHeight": post.height,
                "width": post.width,
                "height": post.height,
                "duration": post.duration,
                "compatibility": "social",
            })
            continue

        reviewed_preview_id = request.previewIds.get(post.id) if not request.preview else None
        if request.previewIds and not request.preview and not reviewed_preview_id:
            failed += 1
            results.append({
                "postId": post.id,
                "status": "failed",
                "message": "reviewed preview is required; refusing to re-encode during Set",
            })
            continue
        if reviewed_preview_id:
            try:
                claimed_preview = _claim_optimize_preview(
                    reviewed_preview_id,
                    post,
                    required_compatibility="social" if social_video else None,
                )
                optimized_result = {
                    "changed": True,
                    "path": claimed_preview["path"],
                    "extension": claimed_preview["extension"],
                    "expectedSha256": claimed_preview["outputSha256"],
                    "compatibility": claimed_preview.get("compatibility"),
                }
                if progress:
                    progress(item_base_progress + max(1, item_span // 2), f"Post #{post.id}: applying reviewed preview")
            except ValueError as exc:
                failed += 1
                results.append({"postId": post.id, "status": "failed", "message": str(exc)})
                continue
        else:
            optimized_result = optimize_media_to_temp(
                old_file_path,
                post.extension,
                image_max_dimension=request.imageMaxDimension,
                image_quality=image_quality,
                video_max_dimension=request.videoMaxDimension,
                video_bitrate_kbps=request.videoBitrateKbps,
                social_compatible=social_video,
                progress=(
                    lambda media_percent, message, base=item_base_progress, span=item_span, pid=post.id:
                        progress(base + int((max(0, min(100, media_percent)) / 100) * span), f"Post #{pid}: {message}")
                ) if progress else None,
            )
        if not optimized_result.get("changed"):
            skipped += 1
            results.append({
                "postId": post.id,
                "status": "skipped",
                "message": optimized_result.get("reason") or "no media changes needed",
                "extension": post.extension,
                "oldSize": old_file_size,
                "newSize": old_file_size,
                "oldWidth": post.width,
                "oldHeight": post.height,
                "width": post.width,
                "height": post.height,
                "duration": post.duration,
                "compatibility": "social" if social_video else None,
            })
            continue

        optimized_path = Path(optimized_result["path"])
        output_extension = str(optimized_result.get("extension") or old_extension).lower()
        compatibility = optimized_result.get("compatibility")
        try:
            new_file_size = optimized_path.stat().st_size
            if new_file_size <= 0:
                optimized_path.unlink(missing_ok=True)
                failed += 1
                results.append({"postId": post.id, "status": "failed", "message": "reviewed output is empty"})
                continue
            if new_file_size >= old_file_size and compatibility != "social":
                optimized_path.unlink(missing_ok=True)
                skipped += 1
                results.append({
                    "postId": post.id,
                    "status": "skipped",
                    "message": "reviewed output is no longer smaller than the original",
                    "extension": post.extension,
                    "oldSize": old_file_size,
                    "newSize": old_file_size,
                    "oldWidth": post.width,
                    "oldHeight": post.height,
                    "width": post.width,
                    "height": post.height,
                    "duration": post.duration,
                })
                continue

            validated_media_info = get_media_info(optimized_path, output_extension)
            if not validated_media_info.get("width") or not validated_media_info.get("height"):
                optimized_path.unlink(missing_ok=True)
                failed += 1
                results.append({
                    "postId": post.id,
                    "status": "failed",
                    "message": "reviewed output failed media inspection",
                })
                continue
            if (
                output_extension in {".mp4", ".webm"}
                and not validated_media_info.get("duration")
            ):
                optimized_path.unlink(missing_ok=True)
                failed += 1
                results.append({
                    "postId": post.id,
                    "status": "failed",
                    "message": "reviewed video has no valid duration",
                })
                continue

            new_sha = calculate_sha256(optimized_path)
            expected_sha = optimized_result.get("expectedSha256")
            if expected_sha and new_sha != expected_sha:
                optimized_path.unlink(missing_ok=True)
                failed += 1
                results.append({
                    "postId": post.id,
                    "status": "failed",
                    "message": "reviewed preview bytes changed after inspection",
                })
                continue
            if new_sha == old_sha:
                optimized_path.unlink(missing_ok=True)
                skipped += 1
                results.append({
                    "postId": post.id,
                    "status": "skipped",
                    "message": "optimized bytes matched original",
                    "extension": post.extension,
                    "oldSize": old_file_size,
                    "newSize": old_file_size,
                    "oldWidth": post.width,
                    "oldHeight": post.height,
                    "width": post.width,
                    "height": post.height,
                    "duration": post.duration,
                    "compatibility": compatibility,
                })
                continue

            existing = await _post_by_sha256(db, new_sha)
            if existing and existing.id != post.id:
                optimized_path.unlink(missing_ok=True)
                failed += 1
                results.append({
                    "postId": post.id,
                    "status": "failed",
                    "message": f"optimized media duplicates post #{existing.id}",
                })
                continue

            if request.preview:
                preview_id, preview_url = _store_optimize_preview(
                    optimized_path,
                    output_extension,
                    post_id=post.id,
                    source_sha256=old_sha,
                    source_extension=old_extension,
                    output_sha256=new_sha,
                    compatibility=compatibility,
                )
                optimized += 1
                results.append({
                    "postId": post.id,
                    "status": "preview",
                    "previewId": preview_id,
                    "previewUrl": preview_url,
                    "extension": output_extension,
                    "oldSize": old_file_size,
                    "newSize": new_file_size,
                    "oldWidth": post.width,
                    "oldHeight": post.height,
                    "width": validated_media_info.get("width"),
                    "height": validated_media_info.get("height"),
                    "duration": validated_media_info.get("duration"),
                    "newSha256": new_sha,
                    "compatibility": compatibility,
                    "sourceCodec": optimized_result.get("sourceCodec"),
                    "sourceBitrateKbps": optimized_result.get("sourceBitrateKbps"),
                    "qualityCrf": optimized_result.get("qualityCrf"),
                })
                continue

            new_subdir = settings.posts_dir / new_sha[:2]
            new_subdir.mkdir(parents=True, exist_ok=True)
            new_file_path = new_subdir / f"{new_sha}{output_extension}"
            if new_file_path.exists():
                optimized_path.unlink(missing_ok=True)
            else:
                optimized_path.replace(new_file_path)

            new_thumb_subdir = settings.thumbs_dir / new_sha[:2]
            new_thumb_path = new_thumb_subdir / f"{new_sha}.jpg"
            thumbnail_created = create_thumbnail(new_file_path, new_thumb_path, output_extension)
            if not thumbnail_created:
                logger.warning("Failed to create thumbnail for optimized post %s", post.id)

            new_phash = phash_for_media(new_file_path, new_thumb_path, output_extension)
            if request.applyMode == "create":
                variant = "social" if compatibility == "social" else "optimized"
                new_post = Post(
                    sha256=new_sha,
                    filename=f"{Path(post.filename).stem}_{variant}{output_extension}",
                    extension=output_extension,
                    file_size=new_file_path.stat().st_size,
                    width=validated_media_info.get("width"),
                    height=validated_media_info.get("height"),
                    duration=validated_media_info.get("duration"),
                    safety=post.safety,
                    source=post.source,
                    phash=new_phash,
                )
                db.add(new_post)
                await db.flush()
                await apply_tags_for_post(db, new_post.id, [tag.name for tag in (post.tags or [])])
                optimized += 1
                results.append({
                    "postId": post.id,
                    "sourcePostId": post.id,
                    "newPostId": new_post.id,
                    "status": "created",
                    "oldSize": old_file_size,
                    "newSize": new_file_path.stat().st_size,
                    "width": new_post.width,
                    "height": new_post.height,
                    "extension": new_post.extension,
                    "compatibility": compatibility,
                    "copiedTags": len(post.tags or []),
                })
                continue

            post.sha256 = new_sha
            post.file_size = new_file_path.stat().st_size
            post.width = validated_media_info.get("width")
            post.height = validated_media_info.get("height")
            post.duration = validated_media_info.get("duration")
            if output_extension != old_extension:
                post.filename = f"{Path(post.filename).stem}{output_extension}"
                post.extension = output_extension
            post.phash = new_phash
            post.updated_at = datetime.utcnow()

            if old_file_path != new_file_path:
                old_file_path.unlink(missing_ok=True)
            if old_thumb_path != new_thumb_path:
                old_thumb_path.unlink(missing_ok=True)
            old_cached_gif = settings.cache_dir / old_sha[:2] / f"{old_sha}.gif"
            old_cached_gif.unlink(missing_ok=True)

            optimized += 1
            results.append({
                "postId": post.id,
                "status": "optimized",
                "oldSize": old_file_size,
                "newSize": new_file_path.stat().st_size,
                "width": post.width,
                "height": post.height,
                "extension": post.extension,
                "compatibility": compatibility,
            })
        except Exception as exc:
            optimized_path.unlink(missing_ok=True)
            failed += 1
            results.append({"postId": post.id, "status": "failed", "message": str(exc)})

    return {
        "processed": len(posts),
        "optimized": optimized,
        "skipped": skipped,
        "failed": failed,
        "preview": request.preview,
        "socialCompatible": request.socialCompatible,
        "applyMode": request.applyMode,
        "results": results,
    }


@router.get("/posts/optimize-previews/{preview_id}")
async def serve_optimize_preview(preview_id: str):
    """Serve a short-lived optimized media preview without changing the post."""
    _cleanup_optimize_previews()
    with _optimize_previews_lock:
        preview = _optimize_previews.get(preview_id)
        if not preview:
            raise HTTPException(status_code=404, detail="Optimize preview not found or expired")
        file_path = preview["path"]
        extension = preview["extension"]

    media_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".webm": "video/webm",
        ".mp4": "video/mp4",
    }
    return FileResponse(file_path, media_type=media_types.get(extension, "application/octet-stream"))


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
