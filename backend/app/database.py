from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    pass


# Create async engine for SQLite
DATABASE_URL = f"sqlite+aiosqlite:///{settings.database_path}"
engine = create_async_engine(DATABASE_URL, echo=settings.debug)

# Enable foreign keys for SQLite
@event.listens_for(engine.sync_engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
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


async def init_db():
    """Initialize database tables."""
    from . import models  # noqa: F401
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

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
