from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Note, Post

router = APIRouter(prefix="/api", tags=["notes"])


class CreateNoteRequest(BaseModel):
    x: float  # 0-100
    y: float  # 0-100
    width: float  # 0-100
    height: float  # 0-100
    text: str


class UpdateNoteRequest(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    text: Optional[str] = None


@router.get("/posts/{post_id}/notes")
async def list_notes(post_id: int, db: AsyncSession = Depends(get_db)):
    """List all notes on a post."""
    # Verify post exists
    post_result = await db.execute(select(Post).where(Post.id == post_id))
    if not post_result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")

    result = await db.execute(select(Note).where(Note.post_id == post_id))
    notes = list(result.scalars().all())
    return [n.to_dict() for n in notes]


@router.post("/posts/{post_id}/notes")
async def create_note(post_id: int, request: CreateNoteRequest, db: AsyncSession = Depends(get_db)):
    """Create a note on a post."""
    # Verify post exists
    post_result = await db.execute(select(Post).where(Post.id == post_id))
    if not post_result.scalars().first():
        raise HTTPException(status_code=404, detail="Post not found")

    # Validate bounds
    if not (0 <= request.x <= 100 and 0 <= request.y <= 100):
        raise HTTPException(status_code=400, detail="Note position must be between 0 and 100")
    if not (0 < request.width <= 100 and 0 < request.height <= 100):
        raise HTTPException(status_code=400, detail="Note size must be between 0 and 100")

    note = Note(
        post_id=post_id,
        x=request.x,
        y=request.y,
        width=request.width,
        height=request.height,
        text=request.text,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note.to_dict()


@router.put("/notes/{note_id}")
async def update_note(note_id: int, request: UpdateNoteRequest, db: AsyncSession = Depends(get_db)):
    """Update a note."""
    result = await db.execute(select(Note).where(Note.id == note_id))
    note = result.scalars().first()

    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    if request.x is not None:
        if not 0 <= request.x <= 100:
            raise HTTPException(status_code=400, detail="Note x position must be between 0 and 100")
        note.x = request.x

    if request.y is not None:
        if not 0 <= request.y <= 100:
            raise HTTPException(status_code=400, detail="Note y position must be between 0 and 100")
        note.y = request.y

    if request.width is not None:
        if not 0 < request.width <= 100:
            raise HTTPException(status_code=400, detail="Note width must be between 0 and 100")
        note.width = request.width

    if request.height is not None:
        if not 0 < request.height <= 100:
            raise HTTPException(status_code=400, detail="Note height must be between 0 and 100")
        note.height = request.height

    if request.text is not None:
        note.text = request.text

    await db.commit()
    await db.refresh(note)
    return note.to_dict()


@router.delete("/notes/{note_id}")
async def delete_note(note_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a note."""
    result = await db.execute(select(Note).where(Note.id == note_id))
    note = result.scalars().first()

    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    await db.delete(note)
    await db.commit()
    return {"success": True}
