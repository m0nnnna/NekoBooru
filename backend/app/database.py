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

    # Source spelling of a tag before normalize_tag() flattened it, so the UI
    # can show "miyu (blue archive)" for the stored "miyu_blue_archive".
    if not _column_exists(conn, "tags", "display_name"):
        conn.exec_driver_sql("ALTER TABLE tags ADD COLUMN display_name VARCHAR(255)")

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

    conn.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_post_ai_analysis_post_id ON post_ai_analysis(post_id)"
    )
    conn.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_post_ai_analysis_profile ON post_ai_analysis(profile)"
    )
    conn.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_post_ai_analysis_model_id ON post_ai_analysis(model_id)"
    )
    try:
        conn.exec_driver_sql(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS post_ai_analysis_fts
            USING fts5(post_id UNINDEXED, search_text, tokenize='unicode61')
            """
        )
    except Exception:
        # Some SQLite builds omit FTS5. Search falls back to the regular
        # post_ai_analysis.search_text column, so startup should keep working.
        pass


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

        # Add any default that is missing rather than only seeding an empty
        # table: a category introduced after a library was created would
        # otherwise never appear in it.
        defaults = [
            ("general", "#0075f8", 0),
            ("artist", "#f8a100", 1),
            ("character", "#00c853", 2),
            ("copyright", "#d500f9", 3),
            ("meta", "#ff5252", 4),
            # Social handles - the tweet username the extension can save, and
            # whatever other accounts get tagged later. Ordered last so adding
            # it leaves the existing categories' order untouched.
            ("user", "#00bcd4", 5),
        ]
        result = await session.execute(select(TagCategory))
        existing = {category.name for category in result.scalars().all()}
        missing = [
            TagCategory(name=name, color=color, order=order)
            for name, color, order in defaults
            if name not in existing
        ]
        if missing:
            session.add_all(missing)
            await session.commit()
