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
    MODEL_REGISTRY,
    QWEN_SEMANTIC_MODEL_IDS,
    AutoTagOptions,
    _semantic_model_id,
    load_options,
    merge_with_existing,
    model_cache_status,
    promote_safety,
    runtime_available,
    tag_media,
    validate_options,
)
from .tagging import replace_tags_for_post
from .ai_analysis import save_analysis_from_result

_active_task: asyncio.Task | None = None

# A job whose first posts all fail is misconfigured, not unlucky; stop it
# rather than grind through the whole library writing nothing.
EARLY_FAILURE_LIMIT = 10
# Results that mean "not this post's kind of media", not a model failure.
_SKIP_ERRORS = {"images_disabled", "videos_disabled", "unsupported_media_type"}
# Target mode: the whole library through every model that can run.
EVERYTHING_MODE = "everything"


class NoModelOutput(RuntimeError):
    """Every model the job asked for failed or could not run on this post."""


def active_task_running() -> bool:
    return _active_task is not None and not _active_task.done()


def _model_unready(model_id: str) -> str | None:
    """Why a model cannot run in this process, or None when it can."""
    if not runtime_available(model_id):
        return "missing_runtime_dependency"
    if not model_cache_status(model_id).get("downloaded"):
        return "model_not_downloaded"
    return None


def _enabled_models(opts: AutoTagOptions) -> list[str]:
    # The three Qwen ids share qwenEnabled; semanticModelId picks the one that runs.
    semantic = _semantic_model_id(opts)
    out = []
    for model_id, meta in MODEL_REGISTRY.items():
        key = meta.get("settingKey")
        if not key or not getattr(opts, key, False):
            continue
        if model_id in QWEN_SEMANTIC_MODEL_IDS and model_id != semantic:
            continue
        out.append(model_id)
    return out


def everything_overrides(opts: AutoTagOptions) -> dict:
    """Option overrides for the "everything" target: every post, every model
    that can run here, ratings applied, similar posts' tags inherited, and the
    semantic analysis saved. Tags are still only ever added (merge_with_existing
    keeps every existing tag and dedupes), so nothing is removed or doubled."""
    overrides = {
        "enabled": True,
        "tagImages": True,
        "tagVideos": True,
        "applySafety": True,
        "inheritSimilarTags": True,
        "saveSemanticAnalysis": True,
    }
    remote = bool(opts.remoteEnabled and opts.remoteUrl)
    for model_id, meta in MODEL_REGISTRY.items():
        key = meta.get("settingKey")
        if key and model_id not in QWEN_SEMANTIC_MODEL_IDS and (remote or _model_unready(model_id) is None):
            overrides[key] = True
    # One Qwen backend runs: the selected one if it is ready, else any that is.
    preferred = _semantic_model_id(opts)
    qwen_ready = [preferred] if remote else [
        model_id
        for model_id in (preferred, *sorted(QWEN_SEMANTIC_MODEL_IDS - {preferred}))
        if _model_unready(model_id) is None
    ]
    if qwen_ready:
        overrides.update(qwenEnabled=True, semanticPoliticalEnabled=True, semanticModelId=qwen_ready[0])
    return overrides


def preflight_error(opts: AutoTagOptions) -> str | None:
    """Refuse a job none of whose models can run, instead of letting it skate
    through the library adding only media-type and provenance tags."""
    if opts.remoteEnabled and opts.remoteUrl:
        return None  # the worker's models are not visible from here
    if not opts.enabled:
        return "Auto-tagging is turned off. Enable it in the AI settings first."
    models = _enabled_models(opts)
    if not models:
        return "No models are enabled. Enable at least one model in the Model Registry."
    problems = {model_id: _model_unready(model_id) for model_id in models}
    if all(problems.values()):
        detail = ", ".join(f"{MODEL_REGISTRY[m]['name']} ({why})" for m, why in problems.items())
        return f"None of the enabled models can run here: {detail}. Install the AI runtime and download a model first."
    return None


def _no_model_output(result) -> bool:
    # _combine_results only sets error when no model produced a tag, so an
    # error with no rating or safety verdict means nothing actually ran.
    return bool(result.error) and result.error not in _SKIP_ERRORS and not result.rating and not result.safety


async def _tag_media_async(path: Path, opts: AutoTagOptions):
    return await asyncio.to_thread(tag_media, path, opts)


async def _inherit_tags_from_similar(
    db, phash: str, exclude_id: int | None, opts: AutoTagOptions, owner_id: int | None = None
) -> tuple[list[str], dict]:
    """Return (tags, evidence) from library posts with a near-identical perceptual hash.

    Uses a linear scan of stored phashes (fine for a personal library). Only
    posts that already have >= inheritSimilarMinTags human-curated tags
    contribute, so fresh untagged entries can't pollute the inheritance pool.

    ``owner_id`` restricts the candidate pool to that user's own posts - tag
    inheritance must stay inside one library, never pull from another user's
    private (or merely shared-with-you) posts.
    """
    try:
        target_int = int(phash, 16)
    except (TypeError, ValueError):
        return [], {}

    conditions = [
        Post.phash.is_not(None),
        Post.phash != "",
        Post.deleted_at.is_(None),
    ]
    if exclude_id is not None:
        conditions.append(Post.id != exclude_id)
    if owner_id is not None:
        conditions.append(Post.owner_id == owner_id)

    # Only id and hash for the scan: loading every post with its tags made
    # each preview hydrate the whole library (~8k posts, ~340k tag rows) to
    # find the handful within reach. Tags load for those near matches only.
    hashes = (await db.execute(select(Post.id, Post.phash).where(*conditions))).all()

    max_dist = opts.inheritSimilarMaxDistance
    min_tags = opts.inheritSimilarMinTags
    near: dict[int, int] = {}
    for post_id, post_phash in hashes:
        try:
            dist = bin(target_int ^ int(post_phash, 16)).count("1")
        except (TypeError, ValueError):
            continue
        if dist <= max_dist:
            near[post_id] = dist

    tags_by_post: dict[int, list[str]] = {post_id: [] for post_id in near}
    if near:
        tag_rows = await db.execute(
            select(PostTag.c.post_id, Tag.name)
            .join(Tag, Tag.id == PostTag.c.tag_id)
            .where(PostTag.c.post_id.in_(list(near)))
        )
        for post_id, name in tag_rows.all():
            tags_by_post[post_id].append(name)

    tag_votes: dict[str, int] = {}
    matched: list[dict] = []
    for post_id, dist in near.items():
        post_tag_names = tags_by_post[post_id]
        if len(post_tag_names) < min_tags:
            continue
        matched.append({"id": post_id, "distance": dist, "tagCount": len(post_tag_names)})
        for name in post_tag_names:
            tag_votes[name] = tag_votes.get(name, 0) + 1

    if not matched:
        return [], {"kind": "similar_posts", "matchedPosts": 0}

    inherited = [t for t, _ in sorted(tag_votes.items(), key=lambda x: -x[1])]
    evidence = {
        "kind": "similar_posts",
        "matchedPosts": len(matched),
        "posts": sorted(matched, key=lambda x: x["distance"])[:5],
    }
    return inherited, evidence


async def merge_similar_post_tags(
    db, result, phash: str | None, exclude_id: int | None, opts: AutoTagOptions, owner_id: int | None = None
) -> None:
    """Fold near-duplicate posts' tags into ``result`` in place.

    Inheritance is part of auto-tagging, so it is off whenever auto-tagging is:
    with ``enabled`` false a preview must leave the post's tags untouched.
    """
    if not (opts.enabled and opts.inheritSimilarTags and phash):
        return
    inherited_tags, inherited_evidence = await _inherit_tags_from_similar(
        db, phash, exclude_id, opts, owner_id=owner_id
    )
    if not inherited_tags:
        return
    existing_set = set(result.tags)
    result.tags.extend(t for t in inherited_tags if t not in existing_set)
    for tag in inherited_tags:
        if tag not in result.categories:
            result.categories[tag] = "general"
    result.evidence = {**(result.evidence or {}), "similarPosts": inherited_evidence}


async def create_job(
    *,
    mode: str,
    dry_run: bool = True,
    post_ids: list[int] | None = None,
    overrides: dict | None = None,
    owner_id: int,
) -> AutoTagJob:
    if active_task_running():
        raise RuntimeError("auto-tag job already running")
    base = load_options()
    raw = {**base.__dict__, **(overrides or {})}
    opts = validate_options(raw)
    if mode == EVERYTHING_MODE:
        opts = validate_options({**opts.__dict__, **everything_overrides(opts)})
    problem = preflight_error(opts)
    if problem:
        raise RuntimeError(problem)
    async with async_session() as db:
        candidates = await candidate_post_ids(db, mode=mode, opts=opts, post_ids=post_ids, owner_id=owner_id)
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
            owner_id=owner_id,
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


async def candidate_post_ids(
    db, *, mode: str, opts: AutoTagOptions, post_ids: list[int] | None = None, owner_id: int
) -> list[int]:
    # Bulk jobs only ever touch the initiating user's own posts - the queued
    # slot itself is a shared, instance-wide hardware resource (see
    # active_task_running above), but the content it processes is not.
    stmt = select(Post.id).where(Post.deleted_at.is_(None), Post.owner_id == owner_id)
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
    elif mode not in {"all", EVERYTHING_MODE}:
        stmt = (
            stmt.outerjoin(PostTag, PostTag.c.post_id == Post.id)
            .group_by(Post.id)
            .having(func.count(PostTag.c.tag_id) <= opts.lightlyTaggedMaxTags)
        )
    rows = await db.execute(stmt.order_by(Post.id))
    return [int(row[0]) for row in rows.all()]


async def estimate(mode: str, owner_id: int, overrides: dict | None = None) -> dict:
    opts = validate_options({**load_options().__dict__, **(overrides or {})})
    counts: dict = {"total": 0, "images": 0, "videos": 0, "gifs": 0}
    if mode == EVERYTHING_MODE:
        # Name what "every model" means on this install before the job starts.
        everything = validate_options({**opts.__dict__, **everything_overrides(opts)})
        counts["models"] = [str(MODEL_REGISTRY[m]["name"]) for m in _enabled_models(everything)]
    async with async_session() as db:
        ids = await candidate_post_ids(db, mode=mode, opts=opts, owner_id=owner_id)
        if not ids:
            return counts
        rows = await db.execute(select(Post.extension).where(Post.id.in_(ids)))
        counts["total"] = len(ids)
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
            if job and job.processed >= EARLY_FAILURE_LIMIT and job.failed == job.processed:
                job.status = "failed"
                job.error = (
                    f"Stopped after the first {job.processed} posts all failed ({job.error}). "
                    "Check that the enabled models are installed and downloaded."
                )
                job.finished_at = datetime.utcnow()
                await db.commit()
                return

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

    if _no_model_output(result):
        # Writing now would stamp only the media-type and provenance tags and
        # mark the post done. Record the failure and leave the post alone.
        db.add(AutoTagSuggestion(
            job_id=job.id if job else None,
            post_id=post.id,
            status="failed",
            suggested_tags=json.dumps(existing_tags),
            suggested_safety=post.safety,
            evidence=json.dumps(result.evidence or {"error": result.error}),
            model=result.model,
            error=result.error,
        ))
        raise NoModelOutput(result.error)

    await merge_similar_post_tags(db, result, post.phash, post.id, opts, owner_id=post.owner_id)

    merged_tags, categories = merge_with_existing(existing_tags, result, opts)
    suggested_safety = promote_safety(post.safety or "safe", result.safety, opts)
    changed = set(merged_tags) != set(existing_tags) or suggested_safety != post.safety

    evidence = dict(result.evidence or {})
    evidence["categories"] = categories
    evidence["displayNames"] = result.display_names
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

        await merge_similar_post_tags(db, result, post.phash, post.id, opts, owner_id=post.owner_id)

        existing_tags = [tag.name for tag in (post.tags or [])]
        merged_tags, categories = merge_with_existing(existing_tags, result, opts)
        return {
            "postId": post.id,
            "existingTags": existing_tags,
            "suggestedTags": merged_tags,
            "suggestedSafety": promote_safety(post.safety or "safe", result.safety, opts),
            "categories": categories,
            "displayNames": result.display_names,
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
    display_names: dict | None = None,
    overrides: dict | None = None,
    suggestion: dict | None = None,
    save_analysis: bool = False,
    profile: str | None = None,
) -> dict:
    opts = validate_options({**load_options().__dict__, **(overrides or {})})
    async with async_session() as db:
        post = (
            await db.execute(
                select(Post).options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites)).where(Post.id == post_id, Post.deleted_at.is_(None))
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
            display_names = generated_preview.get("displayNames") or {}
        await replace_tags_for_post(
            db, post, tags, categories=categories or {}, display_names=display_names or {}
        )
        if safety in {"safe", "sketchy", "unsafe"}:
            post.safety = promote_safety(post.safety or "safe", safety, opts)
        if save_analysis or getattr(opts, "saveSemanticAnalysis", False):
            if suggestion:
                await save_analysis_from_result(db, post.id, suggestion, opts=opts, profile=profile or "post")
            elif generated_preview:
                await save_analysis_from_result(db, post.id, generated_preview, opts=opts, profile=profile or "post")
        await db.commit()
        await db.refresh(post, ["tags", "favorites"])
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
                    .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
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
                display_names = evidence.get("displayNames") or {}
            except Exception:
                tags = []
                categories = {}
                display_names = {}
            await replace_tags_for_post(
                db, post, tags, categories=categories, display_names=display_names
            )
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
