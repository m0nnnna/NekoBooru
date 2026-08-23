from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import get_current_user
from ..models import Comment, Post, User
from ..services.auth import visible_owner_ids

router = APIRouter(prefix="/api", tags=["comments"])


class CreateCommentRequest(BaseModel):
    text: str


class UpdateCommentRequest(BaseModel):
    text: Optional[str] = None


@router.get("/posts/{post_id}/comments")
async def list_comments(
    post_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """List all comments on a post."""
    owner_ids = await visible_owner_ids(db, current_user)
    post_result = await db.execute(
        select(Post.id).where(Post.id == post_id, Post.owner_id.in_(owner_ids))
    )
    if not post_result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")

    result = await db.execute(
        select(Comment).where(Comment.post_id == post_id).order_by(Comment.created_at.asc())
    )
    comments = list(result.scalars().all())
    return [c.to_dict() for c in comments]


@router.post("/posts/{post_id}/comments")
async def create_comment(
    post_id: int,
    request: CreateCommentRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a comment on a post."""
    # Commenting requires owning the post - a shared-library viewer can read
    # but not annotate (sharing is read-only).
    post_result = await db.execute(
        select(Post.id).where(Post.id == post_id, Post.owner_id == current_user.id)
    )
    if not post_result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")

    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Comment text cannot be empty")

    comment = Comment(post_id=post_id, text=request.text.strip())
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return comment.to_dict()


@router.put("/comments/{comment_id}")
async def update_comment(
    comment_id: int,
    request: UpdateCommentRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update a comment."""
    result = await db.execute(
        select(Comment)
        .join(Post, Post.id == Comment.post_id)
        .where(Comment.id == comment_id, Post.owner_id == current_user.id)
    )
    comment = result.scalars().first()

    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    if request.text is not None:
        if not request.text.strip():
            raise HTTPException(status_code=400, detail="Comment text cannot be empty")
        comment.text = request.text.strip()

    await db.commit()
    await db.refresh(comment)
    return comment.to_dict()


@router.delete("/comments/{comment_id}")
async def delete_comment(
    comment_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Delete a comment."""
    result = await db.execute(
        select(Comment)
        .join(Post, Post.id == Comment.post_id)
        .where(Comment.id == comment_id, Post.owner_id == current_user.id)
    )
    comment = result.scalars().first()

    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    await db.delete(comment)
    await db.commit()
    return {"success": True}
