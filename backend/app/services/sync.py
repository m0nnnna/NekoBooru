"""Two-way sync change-tracking.

Registers SQLAlchemy ORM event listeners that append a row to ``sync_log`` on
every insert/update/delete of a syncable entity. Because the listeners hook the
ORM mapper (not individual routers), changes made by the **web UI and the API
alike** are captured automatically.

The inserts here use Core (``SyncLog.__table__.insert()``) on the same
``connection`` the flush is using, so they participate in the same transaction
and do *not* re-trigger ORM events (no recursion).
"""
from datetime import datetime

from sqlalchemy import event, insert, select

from ..models import Post, Tag, Pool, PoolPost, Note, Comment, Favorite, SyncLog


def _log(connection, entity_type: str, entity_key, op: str):
    if entity_key is None:
        return
    connection.execute(
        insert(SyncLog.__table__).values(
            entity_type=entity_type,
            entity_key=str(entity_key),
            op=op,
            ts=datetime.utcnow(),
        )
    )


def _post_sha_for_id(connection, post_id):
    if post_id is None:
        return None
    return connection.execute(
        select(Post.__table__.c.sha256).where(Post.__table__.c.id == post_id)
    ).scalar()


def _pool_uuid_for_id(connection, pool_id):
    if pool_id is None:
        return None
    return connection.execute(
        select(Pool.__table__.c.uuid).where(Pool.__table__.c.id == pool_id)
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
        _log(connection, "post", target.sha256, "upsert")

    @event.listens_for(Post, "after_update")
    def _post_update(mapper, connection, target):
        _log(connection, "post", target.sha256, "upsert")

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
        _log(connection, "pool", target.uuid, "upsert")

    @event.listens_for(Pool, "after_update")
    def _pool_update(mapper, connection, target):
        _log(connection, "pool", target.uuid, "upsert")

    @event.listens_for(Pool, "after_delete")
    def _pool_delete(mapper, connection, target):
        _log(connection, "pool", target.uuid, "delete")

    # --- Pool membership changes count as a change to the parent pool ---
    @event.listens_for(PoolPost, "after_insert")
    def _poolpost_insert(mapper, connection, target):
        _log(connection, "pool", _pool_uuid_for_id(connection, target.pool_id), "upsert")

    @event.listens_for(PoolPost, "after_update")
    def _poolpost_update(mapper, connection, target):
        _log(connection, "pool", _pool_uuid_for_id(connection, target.pool_id), "upsert")

    @event.listens_for(PoolPost, "after_delete")
    def _poolpost_delete(mapper, connection, target):
        _log(connection, "pool", _pool_uuid_for_id(connection, target.pool_id), "upsert")

    # --- Note ---
    @event.listens_for(Note, "after_insert")
    def _note_insert(mapper, connection, target):
        _log(connection, "note", target.uuid, "upsert")

    @event.listens_for(Note, "after_update")
    def _note_update(mapper, connection, target):
        _log(connection, "note", target.uuid, "upsert")

    @event.listens_for(Note, "after_delete")
    def _note_delete(mapper, connection, target):
        _log(connection, "note", target.uuid, "delete")

    # --- Comment ---
    @event.listens_for(Comment, "after_insert")
    def _comment_insert(mapper, connection, target):
        _log(connection, "comment", target.uuid, "upsert")

    @event.listens_for(Comment, "after_update")
    def _comment_update(mapper, connection, target):
        _log(connection, "comment", target.uuid, "upsert")

    @event.listens_for(Comment, "after_delete")
    def _comment_delete(mapper, connection, target):
        _log(connection, "comment", target.uuid, "delete")

    # --- Favorite: keyed by the favorited post's sha256 ---
    @event.listens_for(Favorite, "after_insert")
    def _fav_insert(mapper, connection, target):
        _log(connection, "favorite", _post_sha_for_id(connection, target.post_id), "upsert")

    @event.listens_for(Favorite, "after_delete")
    def _fav_delete(mapper, connection, target):
        _log(connection, "favorite", _post_sha_for_id(connection, target.post_id), "delete")
