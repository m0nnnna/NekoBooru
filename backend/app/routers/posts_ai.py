"""Post AI endpoints: saved AI analyses and per-post auto-tag preview/apply.

Included into routers.posts.router.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import async_session, get_db
from ..dependencies import get_current_user
from ..models import Post, User
from ..services.auth import visible_owner_ids

router = APIRouter()


class SaveAiAnalysisRequest(BaseModel):
    suggestion: dict = {}
    settings: dict = {}
    profile: Optional[str] = None


class UpdateAiAnalysisRequest(BaseModel):
    description: str = ""


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
