from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from ..database import async_session
from ..models import AutoTagJob, AutoTagSuggestion, Post, Tag
from ..models.post import PostTag
from .auto_tagger import (
    AutoTagOptions,
    load_options,
    merge_with_existing,
    promote_safety,
    tag_media,
    validate_options,
)
from .tagging import replace_tags_for_post
from .ai_analysis import save_analysis_from_result

_active_task: asyncio.Task | None = None


def active_task_running() -> bool:
    return _active_task is not None and not _active_task.done()


async def _tag_media_async(path: Path, opts: AutoTagOptions):
    return await asyncio.to_thread(tag_media, path, opts)


async def create_job(
    *,
    mode: str,
    dry_run: bool = True,
    post_ids: list[int] | None = None,
    overrides: dict | None = None,
) -> AutoTagJob:
    if active_task_running():
        raise RuntimeError("auto-tag job already running")
    base = load_options()
    raw = {**base.__dict__, **(overrides or {})}
    opts = validate_options(raw)
    async with async_session() as db:
        candidates = await candidate_post_ids(db, mode=mode, opts=opts, post_ids=post_ids)
        # A non-dry-run job rewrites tags/safety on every candidate, which is
        # destructive and irreversible. Snapshot the DB first so a bad bulk run
        # (e.g. auto-tagging the whole library) can be restored.
        if not dry_run and candidates:
            try:
                from .backup import create_backup

                await create_backup(label=f"pre-autotag-{mode}")
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"could not create pre-auto-tag backup: {exc}")
        job = AutoTagJob(
            status="queued",
            mode=mode,
            dry_run=dry_run,
            total=len(candidates),
            settings_snapshot=json.dumps(opts.__dict__),
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        global _active_task
        _active_task = asyncio.create_task(run_job(job.id, candidates))
        return job


async def candidate_post_ids(db, *, mode: str, opts: AutoTagOptions, post_ids: list[int] | None = None) -> list[int]:
    stmt = select(Post.id).where(Post.deleted_at.is_(None))
    if mode == "selected":
        stmt = stmt.where(Post.id.in_(post_ids or []))
    elif mode == "images":
        stmt = stmt.where(Post.extension.in_([".jpg", ".jpeg", ".png", ".webp", ".gif"]))
    elif mode == "videos":
        stmt = stmt.where(Post.extension.in_([".webm", ".mp4"]))
    elif mode == "untagged":
        stmt = stmt.outerjoin(PostTag, PostTag.c.post_id == Post.id).group_by(Post.id).having(func.count(PostTag.c.tag_id) == 0)
    elif mode == "lightly_tagged":
        stmt = (
            stmt.outerjoin(PostTag, PostTag.c.post_id == Post.id)
            .group_by(Post.id)
            .having(func.count(PostTag.c.tag_id) <= opts.lightlyTaggedMaxTags)
        )
    elif mode != "all":
        stmt = (
            stmt.outerjoin(PostTag, PostTag.c.post_id == Post.id)
            .group_by(Post.id)
            .having(func.count(PostTag.c.tag_id) <= opts.lightlyTaggedMaxTags)
        )
    rows = await db.execute(stmt.order_by(Post.id))
    return [int(row[0]) for row in rows.all()]


async def estimate(mode: str, overrides: dict | None = None) -> dict:
    opts = validate_options({**load_options().__dict__, **(overrides or {})})
    async with async_session() as db:
        ids = await candidate_post_ids(db, mode=mode, opts=opts)
        if not ids:
            return {"total": 0, "images": 0, "videos": 0, "gifs": 0}
        rows = await db.execute(select(Post.extension).where(Post.id.in_(ids)))
        counts = {"total": len(ids), "images": 0, "videos": 0, "gifs": 0}
        for (ext,) in rows.all():
            if ext == ".gif":
                counts["gifs"] += 1
            elif ext in (".mp4", ".webm"):
                counts["videos"] += 1
            else:
                counts["images"] += 1
        return counts


async def run_job(job_id: int, candidates: list[int]) -> None:
    async with async_session() as db:
        job = await db.get(AutoTagJob, job_id)
        if not job:
            return
        job.status = "running"
        job.started_at = datetime.utcnow()
        await db.commit()

    for post_id in candidates:
        async with async_session() as db:
            job = await db.get(AutoTagJob, job_id)
            if not job or job.cancel_requested or job.status == "cancelling":
                if job:
                    job.status = "cancelled"
                    job.finished_at = datetime.utcnow()
                    await db.commit()
                return
            opts = validate_options(json.loads(job.settings_snapshot or "{}"))
            try:
                post = (
                    await db.execute(
                        select(Post)
                        .options(selectinload(Post.tags).selectinload(Tag.category))
                        .where(Post.id == post_id, Post.deleted_at.is_(None))
                    )
                ).scalars().first()
                if not post:
                    job.skipped += 1
                else:
                    changed = await analyze_and_maybe_apply(db, post, opts=opts, job=job, dry_run=bool(job.dry_run))
                    await db.refresh(job)
                    if job.cancel_requested or job.status == "cancelling":
                        job.status = "cancelled"
                        job.finished_at = datetime.utcnow()
                        await db.commit()
                        return
                    if changed:
                        job.tagged += 1
                    else:
                        job.skipped += 1
                job.processed += 1
                await db.commit()
            except Exception as exc:  # noqa: BLE001
                if job:
                    job.failed += 1
                    job.processed += 1
                    job.error = str(exc)
                    await db.commit()

    async with async_session() as db:
        job = await db.get(AutoTagJob, job_id)
        if job:
            job.status = "completed"
            job.finished_at = datetime.utcnow()
            await db.commit()


async def analyze_and_maybe_apply(db, post: Post, *, opts: AutoTagOptions, job: AutoTagJob | None = None, dry_run: bool = True) -> bool:
    path = Path(post.content_path)
    full_path = path if path.is_absolute() else Path(post.content_path)
    # Post.content_path is storage-relative; resolve under settings.posts_dir.
    from ..config import settings
    full_path = settings.posts_dir / post.content_path
    result = await _tag_media_async(full_path, opts)
    existing_tags = [tag.name for tag in (post.tags or [])]
    merged_tags, categories = merge_with_existing(existing_tags, result, opts)
    suggested_safety = promote_safety(post.safety or "safe", result.safety, opts)
    changed = set(merged_tags) != set(existing_tags) or suggested_safety != post.safety

    evidence = dict(result.evidence or {})
    evidence["categories"] = categories
    suggestion = AutoTagSuggestion(
        job_id=job.id if job else None,
        post_id=post.id,
        status="suggested" if dry_run else ("applied" if changed else "skipped"),
        suggested_tags=json.dumps(merged_tags),
        suggested_safety=suggested_safety,
        evidence=json.dumps(evidence or {"error": result.error}),
        model=result.model,
        error=result.error,
        applied_at=datetime.utcnow() if changed and not dry_run else None,
    )
    db.add(suggestion)

    if not dry_run and changed:
        await replace_tags_for_post(db, post, merged_tags, categories=categories, display_names=result.display_names)
        post.safety = suggested_safety
        if getattr(opts, "saveSemanticAnalysis", False):
            await save_analysis_from_result(db, post.id, result, opts=opts, profile=f"bulk:{job.mode}" if job else "bulk")
    return changed


async def preview_post(post_id: int, overrides: dict | None = None) -> dict:
    opts = validate_options({**load_options().__dict__, **(overrides or {})})
    async with async_session() as db:
        post = (
            await db.execute(
                select(Post).options(selectinload(Post.tags).selectinload(Tag.category)).where(Post.id == post_id, Post.deleted_at.is_(None))
            )
        ).scalars().first()
        if not post:
            raise ValueError("post not found")
        from ..config import settings
        result = await _tag_media_async(settings.posts_dir / post.content_path, opts)
        existing_tags = [tag.name for tag in (post.tags or [])]
        merged_tags, categories = merge_with_existing(existing_tags, result, opts)
        return {
            "postId": post.id,
            "existingTags": existing_tags,
            "suggestedTags": merged_tags,
            "suggestedSafety": promote_safety(post.safety or "safe", result.safety, opts),
            "categories": categories,
            "evidence": result.evidence,
            "model": result.model,
            "error": result.error,
            "durationMs": result.duration_ms,
        }


async def apply_post(
    post_id: int,
    tags: list[str] | None = None,
    safety: str | None = None,
    categories: dict | None = None,
    overrides: dict | None = None,
    suggestion: dict | None = None,
    save_analysis: bool = False,
    profile: str | None = None,
) -> dict:
    opts = validate_options({**load_options().__dict__, **(overrides or {})})
    async with async_session() as db:
        post = (
            await db.execute(
                select(Post).options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorite)).where(Post.id == post_id, Post.deleted_at.is_(None))
            )
        ).scalars().first()
        if not post:
            raise ValueError("post not found")
        generated_preview = None
        if tags is None:
            generated_preview = await preview_post(post_id, overrides=overrides)
            tags = generated_preview["suggestedTags"]
            safety = generated_preview["suggestedSafety"]
            categories = generated_preview["categories"]
        await replace_tags_for_post(db, post, tags, categories=categories or {})
        if safety in {"safe", "sketchy", "unsafe"}:
            post.safety = promote_safety(post.safety or "safe", safety, opts)
        if save_analysis or getattr(opts, "saveSemanticAnalysis", False):
            if suggestion:
                await save_analysis_from_result(db, post.id, suggestion, opts=opts, profile=profile or "post")
            elif generated_preview:
                await save_analysis_from_result(db, post.id, generated_preview, opts=opts, profile=profile or "post")
        await db.commit()
        await db.refresh(post, ["tags", "favorite"])
        return post.to_dict()


async def cancel_job(job_id: int) -> dict:
    async with async_session() as db:
        job = await db.get(AutoTagJob, job_id)
        if not job:
            raise ValueError("job not found")
        job.cancel_requested = True
        if job.status in {"queued", "running"}:
            job.status = "cancelling"
        await db.commit()
        await db.refresh(job)
        return job.to_dict()


async def apply_job_suggestions(job_id: int) -> dict:
    async with async_session() as db:
        job = await db.get(AutoTagJob, job_id)
        if not job:
            raise ValueError("job not found")
        result = await db.execute(
            select(AutoTagSuggestion).where(
                AutoTagSuggestion.job_id == job_id,
                AutoTagSuggestion.status == "suggested",
                AutoTagSuggestion.error.is_(None),
            )
        )
        suggestions = list(result.scalars().all())
        # Applying a whole job's suggestions rewrites tags across many posts;
        # back up first so the bulk change can be rolled back if needed.
        if suggestions:
            try:
                from .backup import create_backup

                await create_backup(label=f"pre-apply-job-{job_id}")
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"could not create pre-apply backup: {exc}")
        applied = 0
        for suggestion in suggestions:
            post = (
                await db.execute(
                    select(Post)
                    .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorite))
                    .where(Post.id == suggestion.post_id, Post.deleted_at.is_(None))
                )
            ).scalars().first()
            if not post:
                suggestion.status = "skipped"
                continue
            try:
                tags = json.loads(suggestion.suggested_tags or "[]")
                evidence = json.loads(suggestion.evidence or "{}")
                categories = evidence.get("categories") or {}
            except Exception:
                tags = []
                categories = {}
            await replace_tags_for_post(db, post, tags, categories=categories)
            if suggestion.suggested_safety in {"safe", "sketchy", "unsafe"}:
                opts = validate_options(json.loads(job.settings_snapshot or "{}"))
                post.safety = promote_safety(post.safety or "safe", suggestion.suggested_safety, opts)
            else:
                opts = validate_options(json.loads(job.settings_snapshot or "{}"))
            if getattr(opts, "saveSemanticAnalysis", False):
                await save_analysis_from_result(
                    db,
                    post.id,
                    {
                        "evidence": evidence,
                        "model": suggestion.model,
                        "durationMs": evidence.get("durationMs"),
                    },
                    opts=opts,
                    profile=f"bulk:{job.mode}",
                )
            suggestion.status = "applied"
            suggestion.applied_at = datetime.utcnow()
            applied += 1
        await db.commit()
        return {"jobId": job_id, "applied": applied}
