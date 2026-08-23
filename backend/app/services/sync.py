"""Two-way sync change-tracking.

Registers SQLAlchemy ORM event listeners that append a row to ``sync_log`` on
every insert/update/delete of a syncable entity. Because the listeners hook the
ORM mapper (not individual routers), changes made by the **web UI and the API
alike** are captured automatically.

The inserts here use Core (``SyncLog.__table__.insert()``) on the same
``connection`` the flush is using, so they participate in the same transaction
and do *not* re-trigger ORM events (no recursion).
"""
import logging
from datetime import datetime

from sqlalchemy import event, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Post, Tag, Pool, PoolPost, Note, Comment, Favorite, SyncLog

logger = logging.getLogger(__name__)


async def backfill_sync_log_if_empty(session: AsyncSession) -> int:
    """Seed the change log with the existing library.

    The ORM listeners below only capture changes made *after* the sync layer is
    active, so a database created earlier has an empty ``sync_log`` and a fresh
    client's ``since=0`` pull would return nothing. When the log is empty, emit
    one ``upsert`` per existing entity so the whole library syncs on first pull.
    No-op once any change has been logged (i.e. it never re-fires).

    Returns the number of seed rows written.
    """
    count = (await session.execute(select(func.count(SyncLog.id)))).scalar() or 0
    if count > 0:
        return 0

    now = datetime.utcnow()
    rows: list[dict] = []

    def add(entity_type: str, key) -> None:
        if key:
            rows.append({"entity_type": entity_type, "entity_key": str(key),
                         "op": "upsert", "ts": now})

    for (sha,) in (await session.execute(select(Post.sha256))).all():
        add("post", sha)
    for (name,) in (await session.execute(select(Tag.name))).all():
        add("tag", name)
    for (uuid_,) in (await session.execute(select(Pool.uuid))).all():
        add("pool", uuid_)
    for (uuid_,) in (await session.execute(select(Note.uuid))).all():
        add("note", uuid_)
    for (uuid_,) in (await session.execute(select(Comment.uuid))).all():
        add("comment", uuid_)
    fav_shas = await session.execute(
        select(Post.sha256).join(Favorite, Favorite.post_id == Post.id)
    )
    for (sha,) in fav_shas.all():
        add("favorite", sha)

    if rows:
        await session.execute(insert(SyncLog.__table__), rows)
        await session.commit()
        logger.info("Backfilled sync_log with %d existing entities for first sync.", len(rows))
    return len(rows)


def _log(connection, entity_type: str, entity_key, op: str, user_id=None):
    if entity_key is None:
        return
    connection.execute(
        insert(SyncLog.__table__).values(
            entity_type=entity_type,
            entity_key=str(entity_key),
            op=op,
            ts=datetime.utcnow(),
            user_id=user_id,
        )
    )


def _post_sha_for_id(connection, post_id):
    if post_id is None:
        return None
    return connection.execute(
        select(Post.__table__.c.sha256).where(Post.__table__.c.id == post_id)
    ).scalar()


def _post_owner_for_id(connection, post_id):
    if post_id is None:
        return None
    return connection.execute(
        select(Post.__table__.c.owner_id).where(Post.__table__.c.id == post_id)
    ).scalar()


def _pool_uuid_for_id(connection, pool_id):
    if pool_id is None:
        return None
    return connection.execute(
        select(Pool.__table__.c.uuid).where(Pool.__table__.c.id == pool_id)
    ).scalar()


def _pool_owner_for_id(connection, pool_id):
    if pool_id is None:
        return None
    return connection.execute(
        select(Pool.__table__.c.owner_id).where(Pool.__table__.c.id == pool_id)
    ).scalar()


_listeners_registered = False


def register_sync_listeners():
    """Wire up change-log listeners. Idempotent — safe to call repeatedly."""
    global _listeners_registered
    if _listeners_registered:
        return
    _listeners_registered = True

    # --- Post: always logged as upsert; soft-delete is carried by deleted_at
    #     in the serialized payload, so the client interprets the tombstone. ---
    @event.listens_for(Post, "after_insert")
    def _post_insert(mapper, connection, target):
        _log(connection, "post", target.sha256, "upsert", target.owner_id)

    @event.listens_for(Post, "after_update")
    def _post_update(mapper, connection, target):
        _log(connection, "post", target.sha256, "upsert", target.owner_id)

    # --- Tag ---
    @event.listens_for(Tag, "after_insert")
    def _tag_insert(mapper, connection, target):
        _log(connection, "tag", target.name, "upsert")

    @event.listens_for(Tag, "after_update")
    def _tag_update(mapper, connection, target):
        _log(connection, "tag", target.name, "upsert")

    @event.listens_for(Tag, "after_delete")
    def _tag_delete(mapper, connection, target):
        _log(connection, "tag", target.name, "delete")

    # --- Pool ---
    @event.listens_for(Pool, "after_insert")
    def _pool_insert(mapper, connection, target):
        _log(connection, "pool", target.uuid, "upsert", target.owner_id)

    @event.listens_for(Pool, "after_update")
    def _pool_update(mapper, connection, target):
        _log(connection, "pool", target.uuid, "upsert", target.owner_id)

    @event.listens_for(Pool, "after_delete")
    def _pool_delete(mapper, connection, target):
        _log(connection, "pool", target.uuid, "delete", target.owner_id)

    # --- Pool membership changes count as a change to the parent pool ---
    @event.listens_for(PoolPost, "after_insert")
    def _poolpost_insert(mapper, connection, target):
        _log(
            connection, "pool", _pool_uuid_for_id(connection, target.pool_id), "upsert",
            _pool_owner_for_id(connection, target.pool_id),
        )

    @event.listens_for(PoolPost, "after_update")
    def _poolpost_update(mapper, connection, target):
        _log(
            connection, "pool", _pool_uuid_for_id(connection, target.pool_id), "upsert",
            _pool_owner_for_id(connection, target.pool_id),
        )

    @event.listens_for(PoolPost, "after_delete")
    def _poolpost_delete(mapper, connection, target):
        _log(
            connection, "pool", _pool_uuid_for_id(connection, target.pool_id), "upsert",
            _pool_owner_for_id(connection, target.pool_id),
        )

    # --- Note ---
    @event.listens_for(Note, "after_insert")
    def _note_insert(mapper, connection, target):
        _log(connection, "note", target.uuid, "upsert", _post_owner_for_id(connection, target.post_id))

    @event.listens_for(Note, "after_update")
    def _note_update(mapper, connection, target):
        _log(connection, "note", target.uuid, "upsert", _post_owner_for_id(connection, target.post_id))

    @event.listens_for(Note, "after_delete")
    def _note_delete(mapper, connection, target):
        _log(connection, "note", target.uuid, "delete", _post_owner_for_id(connection, target.post_id))

    # --- Comment ---
    @event.listens_for(Comment, "after_insert")
    def _comment_insert(mapper, connection, target):
        _log(connection, "comment", target.uuid, "upsert", _post_owner_for_id(connection, target.post_id))

    @event.listens_for(Comment, "after_update")
    def _comment_update(mapper, connection, target):
        _log(connection, "comment", target.uuid, "upsert", _post_owner_for_id(connection, target.post_id))

    @event.listens_for(Comment, "after_delete")
    def _comment_delete(mapper, connection, target):
        _log(connection, "comment", target.uuid, "delete", _post_owner_for_id(connection, target.post_id))

    # --- Favorite: keyed by the favorited post's sha256, scoped to the user
    #     who favorited it (not the post owner - a shared-library viewer
    #     favorites independently). ---
    @event.listens_for(Favorite, "after_insert")
    def _fav_insert(mapper, connection, target):
        _log(connection, "favorite", _post_sha_for_id(connection, target.post_id), "upsert", target.user_id)

    @event.listens_for(Favorite, "after_delete")
    def _fav_delete(mapper, connection, target):
        _log(connection, "favorite", _post_sha_for_id(connection, target.post_id), "delete", target.user_id)
