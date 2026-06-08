from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    pass


# Create async engine for SQLite
DATABASE_URL = f"sqlite+aiosqlite:///{settings.database_path}"
engine = create_async_engine(DATABASE_URL, echo=settings.debug)

# Configure SQLite for safe concurrent access. The default rollback journal
# allows only one writer at a time and a busy_timeout of 0, so a background
# auto-tag job writing per-post collides with web/API writes and fails
# instantly with "database is locked". WAL lets readers run alongside a writer,
# and busy_timeout makes writers wait for the lock instead of erroring.
@event.listens_for(engine.sync_engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


# Session factory
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    """Dependency for getting database sessions."""
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


def _column_exists(conn, table: str, column: str) -> bool:
    rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    return any(row[1] == column for row in rows)


def _migrate(conn):
    """Lightweight, idempotent schema migrations for existing databases.

    ``create_all`` only creates missing *tables*, never new columns on existing
    ones, so adding sync columns to a live DB needs explicit ALTERs.
    """
    import uuid as uuid_lib

    # Soft-delete marker on posts.
    if not _column_exists(conn, "posts", "deleted_at"):
        conn.exec_driver_sql("ALTER TABLE posts ADD COLUMN deleted_at DATETIME")
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_posts_deleted_at ON posts(deleted_at)"
        )

    # Perceptual hash for near-duplicate / similarity search.
    if not _column_exists(conn, "posts", "phash"):
        conn.exec_driver_sql("ALTER TABLE posts ADD COLUMN phash VARCHAR(16)")
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_posts_phash ON posts(phash)"
        )

    # Stable cross-device uuids on pools/notes/comments (+ backfill existing rows).
    for table in ("pools", "notes", "comments"):
        if not _column_exists(conn, table, "uuid"):
            conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN uuid VARCHAR(36)")
        missing = conn.exec_driver_sql(
            f"SELECT id FROM {table} WHERE uuid IS NULL OR uuid = ''"
        ).fetchall()
        for (row_id,) in missing:
            conn.exec_driver_sql(
                f"UPDATE {table} SET uuid = '{uuid_lib.uuid4()}' WHERE id = {row_id}"
            )
        conn.exec_driver_sql(
            f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table}_uuid ON {table}(uuid)"
        )


async def init_db():
    """Initialize database tables."""
    from . import models  # noqa: F401
    from .services.sync import register_sync_listeners, backfill_sync_log_if_empty

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_migrate)

    # Capture all subsequent writes (web UI + API) into the sync change log.
    register_sync_listeners()

    # Seed the change log for a pre-existing library so a fresh client's first
    # sync returns everything (no-op once any change has been logged).
    async with async_session() as session:
        await backfill_sync_log_if_empty(session)

    # Seed default tag categories
    async with async_session() as session:
        from .models import TagCategory
        from sqlalchemy import select

        result = await session.execute(select(TagCategory))
        if not result.scalars().first():
            default_categories = [
                TagCategory(name="general", color="#0075f8", order=0),
                TagCategory(name="artist", color="#f8a100", order=1),
                TagCategory(name="character", color="#00c853", order=2),
                TagCategory(name="copyright", color="#d500f9", order=3),
                TagCategory(name="meta", color="#ff5252", order=4),
            ]
            session.add_all(default_categories)
            await session.commit()
