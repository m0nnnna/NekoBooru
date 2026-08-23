from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    pass


def _attach_sqlite_pragma(sync_engine):
    # Configure SQLite for safe concurrent access. The default rollback journal
    # allows only one writer at a time and a busy_timeout of 0, so a background
    # auto-tag job writing per-post collides with web/API writes and fails
    # instantly with "database is locked". WAL lets readers run alongside a
    # writer, and busy_timeout makes writers wait for the lock instead of
    # erroring.
    @event.listens_for(sync_engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


def _create_engine():
    new_engine = create_async_engine(f"sqlite+aiosqlite:///{settings.database_path}", echo=settings.debug)
    _attach_sqlite_pragma(new_engine.sync_engine)
    return new_engine


# Create async engine for SQLite
engine = _create_engine()

# Session factory
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def reset_engine_for_tests():
    """Rebind ``engine``/``async_session`` to the current ``NEKO_DATA_DIR``.

    ``engine`` is created once at import time. Under `unittest discover`,
    every test module runs in the same process, so whichever test class's
    setUpClass happens to import this module first "wins" that engine
    permanently - every later class's own NEKO_DATA_DIR is silently ignored,
    and they all share one database. Call this right after setting the
    NEKO_* env vars in a test's setUpClass to get a genuinely isolated
    database; dispose the returned/previous engine in tearDownClass the same
    way tests/test_auto_tags.py already does.

    Uses ``async_session.configure(bind=...)`` rather than replacing the
    ``async_session`` object, so code elsewhere that already did
    ``from .database import async_session`` keeps working - it's the same
    sessionmaker, now pointed at the new engine. Code that imported ``engine``
    directly (only services/backup.py) does not pick up the swap; that module
    isn't exercised by the test suite.
    """
    global engine
    # config.py only creates settings.data_dir (and its posts/thumbs/uploads/
    # cache subdirs) once, at first import - fine in production (one process,
    # one data dir for its whole life), but this function exists precisely
    # because a test just pointed settings.data_dir somewhere new, and
    # aiosqlite fails with "unable to open database file" against a directory
    # that was never created.
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.posts_dir.mkdir(parents=True, exist_ok=True)
    settings.thumbs_dir.mkdir(parents=True, exist_ok=True)
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    settings.cache_dir.mkdir(parents=True, exist_ok=True)

    engine = _create_engine()
    async_session.configure(bind=engine)
    return engine


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

    # Multi-user: ownership columns. Nullable at the DB level - NULL means
    # "not yet claimed" and is only possible on a pre-existing install before
    # its first-admin bootstrap runs (see routers/auth.py), which backfills
    # every such row to the new admin in one transaction.
    for table in ("posts", "pools", "upload_jobs", "auto_tag_jobs"):
        if not _column_exists(conn, table, "owner_id"):
            conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN owner_id INTEGER REFERENCES users(id)")
            conn.exec_driver_sql(
                f"CREATE INDEX IF NOT EXISTS ix_{table}_owner_id ON {table}(owner_id)"
            )

    # Multi-user: tags/categories/aliases become private per library (each
    # user's own vocabulary, shared only via LibraryShare) instead of one
    # instance-wide set. SQLite can't ALTER a UNIQUE constraint, so - like
    # the favorites rebuild below - swap the old single-column unique index
    # for a new UNIQUE(owner_id, name) one via a full table rebuild.
    #
    # tags.category_id -> tag_categories and tag_aliases.target_id -> tags
    # are live foreign keys, and SQLite silently rewrites a referencing
    # table's FK text to point at the new name whenever the table it
    # references is RENAMEd (e.g. tags -> tags_old repoints
    # tag_aliases.target_id at "tags_old"). Rebuilding one table at a time
    # (rename -> recreate -> drop the old one) then trips a FOREIGN KEY
    # constraint failure on that DROP, because some *other*, not-yet-rebuilt
    # table's schema now references the very "_old" table being dropped.
    # Rebuilding in three separate passes - rename everything first, then
    # recreate everything (parents before children, so a fresh CREATE's
    # REFERENCES clause always names an already-real table), then drop every
    # "_old" table last (children before parents, so nothing still
    # references what's being dropped) - avoids that entirely.
    #
    # post_tags.tag_id and tag_implications.antecedent_id/consequent_id are
    # NOT part of this trio but still reference tags(id) ON DELETE CASCADE,
    # so they get the exact same silent FK rewrite the moment "tags" is
    # renamed to "tags_old" - and SQLite honors ON DELETE CASCADE on a DROP
    # TABLE the same as on a DELETE, so the final "DROP TABLE tags_old"
    # below silently deleted every row of both tables (an earlier build of
    # this migration didn't rebuild them here and shipped that data loss).
    # They're rebuilt in the same three passes as the trio - renamed here,
    # recreated further down once "tags" exists again, dropped last - so by
    # the time tags_old is dropped nothing still cascade-references it.
    #
    # Gated on *any* of the three still missing owner_id, and all three are
    # always rebuilt together (never just the missing ones) so the FK chain
    # above stays intact. A table that already has owner_id (e.g. a dev
    # server's autoreloader restarted mid-migration last time, part-applying
    # it) keeps its existing values via the had_owner flags below rather
    # than being reset to NULL.
    had_tags_owner = _column_exists(conn, "tags", "owner_id")
    had_categories_owner = _column_exists(conn, "tag_categories", "owner_id")
    had_aliases_owner = _column_exists(conn, "tag_aliases", "owner_id")
    if not (had_tags_owner and had_categories_owner and had_aliases_owner):
        # An interrupted earlier attempt (e.g. the dev server's autoreloader
        # killing the process mid-migration) can leave a "_old" table behind
        # from a rename that never got followed by its DROP. It's always
        # safe to discard: we only reach this branch because the *live*
        # table (checked just above) is still in its pre-migration form, so
        # it - not some abandoned rename target - is the authoritative
        # source of truth, and nothing could have written to the orphaned
        # "_old" table since it was renamed away.
        # Reverse dependency order (children before parents), same reasoning
        # as the real drop pass below: a leftover tag_aliases_old could
        # itself hold a live FK to a leftover tags_old.
        for table in ("tag_aliases", "post_tags", "tag_implications", "tags", "tag_categories"):
            conn.exec_driver_sql(f"DROP TABLE IF EXISTS {table}_old")

        conn.exec_driver_sql("ALTER TABLE tag_categories RENAME TO tag_categories_old")
        conn.exec_driver_sql("ALTER TABLE tags RENAME TO tags_old")
        conn.exec_driver_sql("ALTER TABLE tag_aliases RENAME TO tag_aliases_old")
        conn.exec_driver_sql("ALTER TABLE post_tags RENAME TO post_tags_old")
        conn.exec_driver_sql("ALTER TABLE tag_implications RENAME TO tag_implications_old")

        conn.exec_driver_sql(
            """
            CREATE TABLE tag_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER REFERENCES users(id),
                name VARCHAR(50) NOT NULL,
                color VARCHAR(7),
                "order" INTEGER,
                UNIQUE(owner_id, name)
            )
            """
        )
        conn.exec_driver_sql(
            'INSERT INTO tag_categories (id, owner_id, name, color, "order") '
            f'SELECT id, {"owner_id" if had_categories_owner else "NULL"}, name, color, "order" '
            "FROM tag_categories_old"
        )

        conn.exec_driver_sql(
            """
            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER REFERENCES users(id),
                name VARCHAR(255) NOT NULL,
                display_name VARCHAR(255),
                category_id INTEGER REFERENCES tag_categories(id),
                usage_count INTEGER,
                created_at DATETIME,
                UNIQUE(owner_id, name)
            )
            """
        )
        conn.exec_driver_sql(
            f"INSERT INTO tags (id, owner_id, name, display_name, category_id, usage_count, created_at) "
            f'SELECT id, {"owner_id" if had_tags_owner else "NULL"}, name, display_name, category_id, '
            "usage_count, created_at FROM tags_old"
        )

        conn.exec_driver_sql(
            """
            CREATE TABLE tag_aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER REFERENCES users(id),
                alias_name VARCHAR(255) NOT NULL,
                target_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                UNIQUE(owner_id, alias_name)
            )
            """
        )
        conn.exec_driver_sql(
            "INSERT INTO tag_aliases (id, owner_id, alias_name, target_id) "
            f'SELECT id, {"owner_id" if had_aliases_owner else "NULL"}, alias_name, target_id '
            "FROM tag_aliases_old"
        )

        # "tags" (the new one, live again) exists by this point, so these
        # REFERENCES clauses bind to it directly rather than getting rewritten.
        conn.exec_driver_sql(
            """
            CREATE TABLE post_tags (
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (post_id, tag_id)
            )
            """
        )
        conn.exec_driver_sql(
            "INSERT INTO post_tags (post_id, tag_id) SELECT post_id, tag_id FROM post_tags_old"
        )

        conn.exec_driver_sql(
            """
            CREATE TABLE tag_implications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                antecedent_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                consequent_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE
            )
            """
        )
        conn.exec_driver_sql(
            "INSERT INTO tag_implications (id, antecedent_id, consequent_id) "
            "SELECT id, antecedent_id, consequent_id FROM tag_implications_old"
        )

        # Children before parents: post_tags_old/tag_implications_old/
        # tag_aliases_old all still carry a live ON DELETE CASCADE reference
        # to tags_old, so they must be dropped before tags_old is - dropping
        # tags_old first would cascade-delete the very rows just copied out
        # of them (this is exactly the data loss described above).
        conn.exec_driver_sql("DROP TABLE tag_aliases_old")
        conn.exec_driver_sql("DROP TABLE post_tags_old")
        conn.exec_driver_sql("DROP TABLE tag_implications_old")
        conn.exec_driver_sql("DROP TABLE tags_old")
        conn.exec_driver_sql("DROP TABLE tag_categories_old")

        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_tag_categories_owner_id ON tag_categories(owner_id)"
        )
        conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_tags_owner_id ON tags(owner_id)")
        conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_tags_name ON tags(name)")
        conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_tag_aliases_owner_id ON tag_aliases(owner_id)")
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_tag_aliases_alias_name ON tag_aliases(alias_name)"
        )

    # Repair for an install that already ran an earlier, buggy build of the
    # rebuild above (one that didn't know about post_tags/tag_implications -
    # see the comment on the block above). That build left "tags" itself
    # fine, but post_tags.tag_id and tag_implications.antecedent_id/
    # consequent_id still say "REFERENCES tags_old(id)" in their stored
    # schema - a table that no longer exists, since it was dropped at the
    # end of that migration (which is also what silently cascade-deleted
    # every row of both tables at that moment). The dangling reference then
    # makes every subsequent INSERT into either table fail outright with
    # "no such table: main.tags_old" under PRAGMA foreign_keys=ON, so a post
    # or an implication can never regain a tag. This runs unconditionally
    # (not gated on had_*_owner above, since that gate is already satisfied
    # on an install this happened to) and just repoints the schema at the
    # live "tags" table - it cannot recover rows already lost to the
    # cascade, only stop the ongoing breakage.
    def _references_stale_tags_table(table: str) -> bool:
        row = conn.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=:t", {"t": table}
        ).fetchone()
        return bool(row) and "tags_old" in row[0]

    if _references_stale_tags_table("post_tags"):
        conn.exec_driver_sql("DROP TABLE IF EXISTS post_tags_old")
        conn.exec_driver_sql("ALTER TABLE post_tags RENAME TO post_tags_old")
        conn.exec_driver_sql(
            """
            CREATE TABLE post_tags (
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (post_id, tag_id)
            )
            """
        )
        conn.exec_driver_sql(
            "INSERT INTO post_tags (post_id, tag_id) SELECT post_id, tag_id FROM post_tags_old"
        )
        conn.exec_driver_sql("DROP TABLE post_tags_old")

    if _references_stale_tags_table("tag_implications"):
        conn.exec_driver_sql("DROP TABLE IF EXISTS tag_implications_old")
        conn.exec_driver_sql("ALTER TABLE tag_implications RENAME TO tag_implications_old")
        conn.exec_driver_sql(
            """
            CREATE TABLE tag_implications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                antecedent_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                consequent_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE
            )
            """
        )
        conn.exec_driver_sql(
            "INSERT INTO tag_implications (id, antecedent_id, consequent_id) "
            "SELECT id, antecedent_id, consequent_id FROM tag_implications_old"
        )
        conn.exec_driver_sql("DROP TABLE tag_implications_old")

    # Legacy backfill: an install that already had users before this
    # migration ran left its tags/categories/aliases owner_id NULL (they
    # used to be one instance-wide vocabulary). Assign them to the earliest
    # admin, mirroring what bootstrap_admin does for posts/pools on a
    # single-user install's first-ever bootstrap. A no-op once applied (and
    # a no-op before any user exists - bootstrap_admin seeds fresh rows then).
    has_users = conn.exec_driver_sql("SELECT COUNT(*) FROM users").scalar()
    if has_users:
        legacy_owner = conn.exec_driver_sql(
            "SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1"
        ).scalar()
        if legacy_owner is None:
            legacy_owner = conn.exec_driver_sql("SELECT id FROM users ORDER BY id LIMIT 1").scalar()
        if legacy_owner is not None:
            for table in ("tags", "tag_categories", "tag_aliases"):
                conn.exec_driver_sql(
                    f"UPDATE {table} SET owner_id = {int(legacy_owner)} WHERE owner_id IS NULL"
                )

    # sync_log: NULL user_id = a pre-bootstrap change from before any user
    # existed; non-NULL = scoped to that user's own library (every entity,
    # tags included, is per-user now).
    if not _column_exists(conn, "sync_log", "user_id"):
        conn.exec_driver_sql("ALTER TABLE sync_log ADD COLUMN user_id INTEGER REFERENCES users(id)")
        conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_sync_log_user_id ON sync_log(user_id)")

    # favorites: was UNIQUE(post_id) system-wide; multi-user needs
    # UNIQUE(post_id, user_id) so each user favorites independently. SQLite
    # compiles a column-level unique=True into a table constraint that can't
    # be altered directly, so this rebuilds the table instead of ALTERing it.
    if not _column_exists(conn, "favorites", "user_id"):
        conn.exec_driver_sql("ALTER TABLE favorites RENAME TO favorites_old")
        conn.exec_driver_sql(
            """
            CREATE TABLE favorites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id),
                created_at DATETIME,
                UNIQUE(post_id, user_id)
            )
            """
        )
        conn.exec_driver_sql(
            "INSERT INTO favorites (id, post_id, user_id, created_at) "
            "SELECT id, post_id, NULL, created_at FROM favorites_old"
        )
        conn.exec_driver_sql("DROP TABLE favorites_old")
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_favorites_user_id ON favorites(user_id)"
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


# Default tag-category palette every library starts with. Each user gets
# their own copy of these rows (see ensure_default_categories) rather than
# one instance-wide set, matching how tags themselves are now per-user.
DEFAULT_TAG_CATEGORIES = [
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


async def ensure_default_categories(session: AsyncSession, user_id: int) -> None:
    """Seed any of ``DEFAULT_TAG_CATEGORIES`` this user doesn't have yet.

    Adds only what's missing rather than only seeding an empty set: a
    category introduced after a library was created would otherwise never
    appear in it. Called for every user at startup, and for a single user
    right after they're created (bootstrap_admin / create_user).
    """
    from sqlalchemy import select
    from .models import TagCategory

    result = await session.execute(select(TagCategory.name).where(TagCategory.owner_id == user_id))
    existing = {name for (name,) in result.all()}
    missing = [
        TagCategory(owner_id=user_id, name=name, color=color, order=order)
        for name, color, order in DEFAULT_TAG_CATEGORIES
        if name not in existing
    ]
    if missing:
        session.add_all(missing)
        await session.commit()


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

    # Seed default tag categories for every existing user. Covers both a
    # genuinely fresh per-user library and the migration backfill case (an
    # upgraded install where _migrate() just reassigned the old global
    # categories to one admin, leaving every other user with none yet).
    async with async_session() as session:
        from sqlalchemy import select
        from .models import User

        user_ids = [uid for (uid,) in (await session.execute(select(User.id))).all()]
    for user_id in user_ids:
        async with async_session() as session:
            await ensure_default_categories(session, user_id)
