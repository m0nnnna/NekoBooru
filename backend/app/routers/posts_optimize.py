"""Bulk media optimisation for posts: the optimize job runner, preview store and endpoints.

Included into routers.posts.router. Names it needs
from routers.posts are looked up as ``posts_router.<name>`` at call time.
"""

import asyncio
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import async_session, get_db
from ..config import settings
from ..dependencies import get_current_user
from ..models import Post, Tag, User
from ..utils.hashing import calculate_sha256
from ..services.media import create_thumbnail, get_media_info, optimize_media_to_temp
from ..services.tagging import process_tags_for_post as apply_tags_for_post

router = APIRouter()


_optimize_jobs_lock = threading.Lock()
_optimize_jobs: dict[str, dict] = {}
_optimize_previews_lock = threading.Lock()
_optimize_previews: dict[str, dict] = {}
_OPTIMIZE_PREVIEW_TTL_SECONDS = 60 * 60


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

            existing = await posts_router._post_by_sha256(db, new_sha)
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
                    owner_id=post.owner_id,
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
                await apply_tags_for_post(
                    db, new_post.id, [tag.name for tag in (post.tags or [])], owner_id=post.owner_id
                )
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


# Imported last, not first: routers.posts imports this module while it is itself
# loading, and the names above are only read through it at call time. Either
# module can then be imported first.
from . import posts as posts_router  # noqa: E402
