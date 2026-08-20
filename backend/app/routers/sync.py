"""Two-way sync endpoints for the Android (and any offline) client.

- ``GET  /api/sync/changes`` — pull everything that changed since a cursor.
- ``POST /api/sync/push``    — push a batch of offline changes home.

Stable cross-device keys: posts -> sha256, tags -> name, pools/notes/comments
-> uuid, favorites -> the post's sha256. Conflicts use last-write-wins by
``updatedAt`` (single user across devices, so genuine conflicts are rare).
"""
from datetime import datetime
from typing import Optional, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, delete, insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..config import settings
from ..models import Post, Tag, Pool, PoolPost, Note, Comment, Favorite, SyncLog
from ..models.post import PostTag
from ..utils.hashing import calculate_sha256
from ..services.media import get_media_info, create_thumbnail, move_to_storage
from .posts import process_tags_for_post
from .uploads import get_upload_path, remove_upload_token

router = APIRouter(prefix="/api/sync", tags=["sync"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _max_cursor(db: AsyncSession) -> int:
    from sqlalchemy import func
    result = await db.execute(select(func.max(SyncLog.id)))
    return result.scalar() or 0


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, AttributeError):
        return None


async def _post_by_sha(db: AsyncSession, sha256: str) -> Optional[Post]:
    result = await db.execute(
        select(Post)
        .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorite))
        .where(Post.sha256 == sha256)
    )
    return result.scalars().first()


async def _serialize_pool(db: AsyncSession, pool: Pool) -> dict:
    # Build directly (don't call pool.to_dict(): it touches the lazy ``posts``
    # relationship, which would trigger async IO from a sync context).
    rows = await db.execute(
        select(Post.sha256)
        .join(PoolPost, PoolPost.post_id == Post.id)
        .where(PoolPost.pool_id == pool.id)
        .order_by(PoolPost.order)
    )
    shas = [r[0] for r in rows.all()]
    return {
        "id": pool.id,
        "uuid": pool.uuid,
        "name": pool.name,
        "description": pool.description,
        "postCount": len(shas),
        "createdAt": pool.created_at.isoformat() if pool.created_at else None,
        "updatedAt": pool.updated_at.isoformat() if pool.updated_at else None,
        "postSha256s": shas,
    }


async def _serialize_note(db: AsyncSession, note: Note) -> dict:
    data = note.to_dict()
    sha = await db.execute(select(Post.sha256).where(Post.id == note.post_id))
    data["postSha256"] = sha.scalar()
    return data


async def _serialize_comment(db: AsyncSession, comment: Comment) -> dict:
    data = comment.to_dict()
    sha = await db.execute(select(Post.sha256).where(Post.id == comment.post_id))
    data["postSha256"] = sha.scalar()
    return data


# ---------------------------------------------------------------------------
# GET /api/sync/changes
# ---------------------------------------------------------------------------

@router.get("/changes")
async def get_changes(
    since: int = Query(0, ge=0, description="Last cursor the client has applied"),
    limit: int = Query(500, ge=1, le=2000),
    db: AsyncSession = Depends(get_db),
):
    """Return entity changes with id > ``since``, plus the new cursor.

    Multiple log rows for the same entity within the window are collapsed to the
    latest state. Call repeatedly while ``hasMore`` is true.
    """
    rows = (
        await db.execute(
            select(SyncLog).where(SyncLog.id > since).order_by(SyncLog.id.asc()).limit(limit)
        )
    ).scalars().all()

    has_more = len(rows) == limit
    new_cursor = rows[-1].id if rows else since

    # Collapse to the latest op per (type, key); preserve first-seen order.
    latest: dict[tuple[str, str], str] = {}
    order: list[tuple[str, str]] = []
    for row in rows:
        k = (row.entity_type, row.entity_key)
        if k not in latest:
            order.append(k)
        latest[k] = row.op

    changes: list[dict[str, Any]] = []
    for (etype, key) in order:
        op = latest[(etype, key)]

        if op == "delete":
            changes.append({"type": etype, "op": "delete", "key": key})
            continue

        # op == "upsert": resolve the current entity, else emit a tombstone.
        if etype == "post":
            post = await _post_by_sha(db, key)
            if post is None:
                changes.append({"type": "post", "op": "delete", "key": key})
            else:
                changes.append({"type": "post", "op": "upsert", "key": key, "data": post.to_dict()})

        elif etype == "tag":
            tag = (
                await db.execute(
                    select(Tag).options(selectinload(Tag.category)).where(Tag.name == key)
                )
            ).scalars().first()
            if tag is None:
                changes.append({"type": "tag", "op": "delete", "key": key})
            else:
                changes.append({"type": "tag", "op": "upsert", "key": key, "data": tag.to_dict()})

        elif etype == "pool":
            pool = (
                await db.execute(select(Pool).where(Pool.uuid == key))
            ).scalars().first()
            if pool is None:
                changes.append({"type": "pool", "op": "delete", "key": key})
            else:
                changes.append({"type": "pool", "op": "upsert", "key": key, "data": await _serialize_pool(db, pool)})

        elif etype == "note":
            note = (
                await db.execute(select(Note).where(Note.uuid == key))
            ).scalars().first()
            if note is None:
                changes.append({"type": "note", "op": "delete", "key": key})
            else:
                changes.append({"type": "note", "op": "upsert", "key": key, "data": await _serialize_note(db, note)})

        elif etype == "comment":
            comment = (
                await db.execute(select(Comment).where(Comment.uuid == key))
            ).scalars().first()
            if comment is None:
                changes.append({"type": "comment", "op": "delete", "key": key})
            else:
                changes.append({"type": "comment", "op": "upsert", "key": key, "data": await _serialize_comment(db, comment)})

        elif etype == "favorite":
            # Favorited iff a Favorite row exists for the post with this sha.
            post = (await db.execute(select(Post).where(Post.sha256 == key))).scalars().first()
            favorited = False
            if post is not None:
                fav = (
                    await db.execute(select(Favorite).where(Favorite.post_id == post.id))
                ).scalars().first()
                favorited = fav is not None
            changes.append({
                "type": "favorite",
                "op": "upsert" if favorited else "delete",
                "key": key,
            })

    return {"cursor": new_cursor, "hasMore": has_more, "changes": changes}


# ---------------------------------------------------------------------------
# POST /api/sync/push
# ---------------------------------------------------------------------------

class PushChange(BaseModel):
    type: str                       # post | favorite | pool | note | comment
    op: str = "upsert"              # upsert | delete
    # post
    clientId: Optional[str] = None  # client-local id, echoed back in the result
    sha256: Optional[str] = None
    contentToken: Optional[str] = None  # from a prior POST /api/uploads
    tags: Optional[list[str]] = None
    safety: Optional[str] = None
    source: Optional[str] = None
    # pool / note / comment stable id + linkage
    uuid: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    postSha256: Optional[str] = None
    postSha256s: Optional[list[str]] = None
    text: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    # LWW
    updatedAt: Optional[str] = None


class PushRequest(BaseModel):
    changes: list[PushChange] = []


async def _resolve_post_id(db: AsyncSession, sha256: Optional[str]) -> Optional[int]:
    if not sha256:
        return None
    return (
        await db.execute(select(Post.id).where(Post.sha256 == sha256))
    ).scalar()


async def _apply_post(db: AsyncSession, ch: PushChange) -> dict:
    incoming_dt = _parse_dt(ch.updatedAt)

    # Delete (soft) by sha.
    if ch.op == "delete":
        post = await _post_by_sha(db, ch.sha256) if ch.sha256 else None
        if post and post.deleted_at is None:
            post.deleted_at = datetime.utcnow()
        return {"clientId": ch.clientId, "type": "post", "sha256": ch.sha256,
                "serverId": post.id if post else None, "status": "deleted"}

    # New content uploaded offline -> materialize from the upload token.
    if ch.contentToken:
        temp_path = get_upload_path(ch.contentToken)
        if not temp_path or not temp_path.exists():
            return {"clientId": ch.clientId, "type": "post", "status": "error",
                    "message": "Invalid or expired content token"}
        sha256 = calculate_sha256(temp_path)
        existing = await _post_by_sha(db, sha256)
        if existing:
            # Dedup: same content already present. Merge metadata (LWW) and undelete.
            remove_upload_token(ch.contentToken)
            temp_path.unlink(missing_ok=True)
            if existing.deleted_at is not None:
                existing.deleted_at = None
            await _merge_post_metadata(db, existing, ch, incoming_dt)
            return {"clientId": ch.clientId, "type": "post", "sha256": sha256,
                    "serverId": existing.id, "status": "deduped"}

        extension = temp_path.suffix.lower()
        file_size = temp_path.stat().st_size
        media_info = get_media_info(temp_path, extension)
        final_path = move_to_storage(temp_path, sha256, extension)
        thumb_path = settings.thumbs_dir / sha256[:2] / f"{sha256}.jpg"
        create_thumbnail(final_path, thumb_path, extension)

        post = Post(
            sha256=sha256,
            filename=temp_path.name,
            extension=extension,
            file_size=file_size,
            width=media_info.get("width"),
            height=media_info.get("height"),
            duration=media_info.get("duration"),
            safety=ch.safety or "safe",
            source=ch.source,
        )
        db.add(post)
        await db.flush()
        await process_tags_for_post(db, post.id, ch.tags or [])
        remove_upload_token(ch.contentToken)
        return {"clientId": ch.clientId, "type": "post", "sha256": sha256,
                "serverId": post.id, "status": "created"}

    # Metadata-only edit of an existing post (by sha).
    post = await _post_by_sha(db, ch.sha256) if ch.sha256 else None
    if post is None:
        return {"clientId": ch.clientId, "type": "post", "sha256": ch.sha256,
                "status": "error", "message": "Post not found and no content token"}
    status = await _merge_post_metadata(db, post, ch, incoming_dt)
    return {"clientId": ch.clientId, "type": "post", "sha256": ch.sha256,
            "serverId": post.id, "status": status}


async def _merge_post_metadata(db: AsyncSession, post: Post, ch: PushChange,
                               incoming_dt: Optional[datetime]) -> str:
    """Apply tags/safety/source with last-write-wins. Returns status string."""
    if incoming_dt and post.updated_at and post.updated_at > incoming_dt:
        return "conflict"  # server is newer; keep it
    changed = False
    if ch.safety is not None and ch.safety != post.safety:
        post.safety = ch.safety
        changed = True
    if ch.source is not None and ch.source != post.source:
        post.source = ch.source
        changed = True
    if ch.tags is not None:
        await db.execute(delete(PostTag).where(PostTag.c.post_id == post.id))
        await process_tags_for_post(db, post.id, ch.tags)
        changed = True
    if changed:
        post.updated_at = datetime.utcnow()
    return "updated"


async def _apply_favorite(db: AsyncSession, ch: PushChange) -> dict:
    post_id = await _resolve_post_id(db, ch.sha256)
    if post_id is None:
        return {"type": "favorite", "sha256": ch.sha256, "status": "error",
                "message": "Post not found"}
    fav = (await db.execute(select(Favorite).where(Favorite.post_id == post_id))).scalars().first()
    if ch.op == "delete":
        if fav:
            await db.delete(fav)
        return {"type": "favorite", "sha256": ch.sha256, "status": "unfavorited"}
    if not fav:
        db.add(Favorite(post_id=post_id))
    return {"type": "favorite", "sha256": ch.sha256, "status": "favorited"}


async def _apply_pool(db: AsyncSession, ch: PushChange) -> dict:
    pool = (await db.execute(select(Pool).where(Pool.uuid == ch.uuid))).scalars().first() if ch.uuid else None

    if ch.op == "delete":
        if pool:
            await db.delete(pool)
        return {"type": "pool", "uuid": ch.uuid, "status": "deleted"}

    if pool is None:
        pool = Pool(uuid=ch.uuid, name=ch.name or "Untitled", description=ch.description)
        db.add(pool)
        await db.flush()
    else:
        if ch.name is not None:
            pool.name = ch.name
        if ch.description is not None:
            pool.description = ch.description

    # Reconcile membership to the provided ordered sha list.
    if ch.postSha256s is not None:
        await db.execute(delete(PoolPost).where(PoolPost.pool_id == pool.id))
        order = 0
        for sha in ch.postSha256s:
            pid = await _resolve_post_id(db, sha)
            if pid is not None:
                db.add(PoolPost(pool_id=pool.id, post_id=pid, order=order))
                order += 1
    pool.updated_at = datetime.utcnow()
    return {"type": "pool", "uuid": pool.uuid, "serverId": pool.id, "status": "upserted"}


async def _apply_note(db: AsyncSession, ch: PushChange) -> dict:
    note = (await db.execute(select(Note).where(Note.uuid == ch.uuid))).scalars().first() if ch.uuid else None

    if ch.op == "delete":
        if note:
            await db.delete(note)
        return {"type": "note", "uuid": ch.uuid, "status": "deleted"}

    post_id = await _resolve_post_id(db, ch.postSha256)
    if post_id is None and note is None:
        return {"type": "note", "uuid": ch.uuid, "status": "error", "message": "Post not found"}

    if note is None:
        note = Note(
            uuid=ch.uuid, post_id=post_id,
            x=ch.x or 0, y=ch.y or 0, width=ch.width or 1, height=ch.height or 1,
            text=ch.text or "",
        )
        db.add(note)
    else:
        if ch.x is not None: note.x = ch.x
        if ch.y is not None: note.y = ch.y
        if ch.width is not None: note.width = ch.width
        if ch.height is not None: note.height = ch.height
        if ch.text is not None: note.text = ch.text
    return {"type": "note", "uuid": ch.uuid, "status": "upserted"}


async def _apply_comment(db: AsyncSession, ch: PushChange) -> dict:
    comment = (await db.execute(select(Comment).where(Comment.uuid == ch.uuid))).scalars().first() if ch.uuid else None

    if ch.op == "delete":
        if comment:
            await db.delete(comment)
        return {"type": "comment", "uuid": ch.uuid, "status": "deleted"}

    post_id = await _resolve_post_id(db, ch.postSha256)
    if post_id is None and comment is None:
        return {"type": "comment", "uuid": ch.uuid, "status": "error", "message": "Post not found"}

    if comment is None:
        comment = Comment(uuid=ch.uuid, post_id=post_id, text=ch.text or "")
        db.add(comment)
    else:
        if ch.text is not None:
            comment.text = ch.text
    return {"type": "comment", "uuid": ch.uuid, "status": "upserted"}


_DISPATCH = {
    "post": _apply_post,
    "favorite": _apply_favorite,
    "pool": _apply_pool,
    "note": _apply_note,
    "comment": _apply_comment,
}


@router.post("/push")
async def push_changes(request: PushRequest, db: AsyncSession = Depends(get_db)):
    """Apply a batch of offline client changes; returns per-item results.

    The returned ``cursor`` is the change-log head *after* applying this batch,
    so the client can advance past its own writes and avoid re-pulling them.
    """
    results = []
    for ch in request.changes:
        handler = _DISPATCH.get(ch.type)
        if handler is None:
            results.append({"type": ch.type, "status": "error", "message": "Unknown type"})
            continue
        # Commit per item so one bad item doesn't roll back the whole batch.
        try:
            result = await handler(db, ch)
            await db.commit()
            results.append(result)
        except Exception as e:
            await db.rollback()
            results.append({"type": ch.type, "clientId": ch.clientId,
                            "status": "error", "message": str(e)})

    cursor = await _max_cursor(db)
    return {"cursor": cursor, "results": results}
