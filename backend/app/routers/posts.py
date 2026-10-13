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
from ..models.post import PostTag, tag_detail_dict
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
from ..utils.module_split import mirror_rebinding
from . import posts_ai, posts_media, posts_optimize
from .posts_ai import (
    SaveAiAnalysisRequest,
    UpdateAiAnalysisRequest,
    _require_own_post,
    apply_auto_tags,
    delete_saved_post_ai_analysis,
    get_post_ai_analysis,
    preview_auto_tags,
    save_post_ai_analysis,
    update_saved_post_ai_analysis,
)
from .posts_media import _require_media_access, serve_post_media, serve_thumbnail, toggle_favorite
from .posts_optimize import (
    _OPTIMIZE_PREVIEW_TTL_SECONDS,
    BulkOptimizeMediaRequest,
    _bulk_optimize_posts_impl,
    _claim_optimize_preview,
    _cleanup_optimize_previews,
    _optimize_jobs,
    _optimize_jobs_lock,
    _optimize_previews,
    _optimize_previews_lock,
    _run_optimize_job_thread,
    _set_optimize_job,
    _store_optimize_preview,
    bulk_optimize_posts,
    get_optimize_job,
    serve_optimize_preview,
    start_optimize_job,
)

router = APIRouter(prefix="/api", tags=["posts"])


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


class BulkDeleteRequest(BaseModel):
    postIds: list[int]


class BulkUpdateRequest(BaseModel):
    postIds: list[int]
    tagMode: Optional[str] = None
    tags: list[str] = []
    safety: Optional[str] = None


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
            owner_id=current_user_id,
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


async def process_tags_for_post(db: AsyncSession, post_id: int, tag_names: list[str], *, owner_id: int):
    """Process tags for a post using direct SQL inserts to avoid async issues."""
    await apply_tags_for_post(db, post_id, tag_names, owner_id=owner_id)


async def _serialize_post_page(db: AsyncSession, posts: list[Post], current_user_id: int) -> list[dict]:
    """Post.to_dict() for a page of posts, fetching tags and favorites as flat rows.

    A page averages ~40 tags per post; selectinload() hydrated every one as a
    Tag (plus its category) ORM object, which cost more than the search itself.
    Ordered by tag_id per post, the same order the selectinload returned.
    """
    ids = [post.id for post in posts]
    if not ids:
        return []
    details: dict[int, list[dict]] = {post_id: [] for post_id in ids}
    rows = await db.execute(
        select(
            PostTag.c.post_id, Tag.name, Tag.display_name, Tag.sankaku_name, Tag.usage_count,
            TagCategory.name, TagCategory.color,
        )
        .select_from(PostTag)
        .join(Tag, Tag.id == PostTag.c.tag_id)
        .outerjoin(TagCategory, TagCategory.id == Tag.category_id)
        .where(PostTag.c.post_id.in_(ids))
        .order_by(PostTag.c.post_id, PostTag.c.tag_id)
    )
    for post_id, *columns in rows.all():
        details[post_id].append(tag_detail_dict(*columns))
    favorited = set(
        (
            await db.execute(
                select(Favorite.post_id).where(
                    Favorite.post_id.in_(ids), Favorite.user_id == current_user_id
                )
            )
        ).scalars().all()
    )
    return [
        post.to_dict(current_user_id, tag_details=details[post.id], is_favorited=post.id in favorited)
        for post in posts
    ]


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
        eager_load=False,
    )

    return {
        "results": await _serialize_post_page(db, posts, current_user.id),
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


# Route order is part of matching; the parts' routes are included where they used to be.
router.include_router(posts_ai.router)


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


router.include_router(posts_optimize.router)
router.include_router(posts_media.router)

mirror_rebinding(__name__, (posts_ai, posts_media, posts_optimize))
