from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, Float, DateTime, ForeignKey, Table, inspect
from sqlalchemy.orm import relationship

from ..database import Base


def _tag_detail(tag) -> dict:
    """Serialize a tag with its category, tolerating an unloaded relationship.

    Post queries eager-load Tag.category, but touching it when a caller forgot
    would raise MissingGreenlet under async rather than just losing a colour.
    """
    category = None
    if "category" not in inspect(tag).unloaded:
        category = tag.category
    return {
        "name": tag.name,
        # Source spelling when the tagger supplied one ("miyu (blue archive)"),
        # otherwise the flattened name made readable.
        "displayName": tag.display_name or tag.name.replace("_", " "),
        "category": category.name if category else "general",
        "categoryColor": category.color if category else "#808080",
        "usageCount": tag.usage_count or 0,
    }


# Junction table for posts and tags
PostTag = Table(
    "post_tags",
    Base.metadata,
    Column("post_id", Integer, ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)


class Post(Base):
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Nullable only for rows created before the multi-user migration ran;
    # the bootstrap-admin flow backfills every such row to the first admin.
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    sha256 = Column(String(64), unique=True, nullable=False, index=True)
    filename = Column(String(255), nullable=False)
    extension = Column(String(10), nullable=False)
    file_size = Column(Integer, nullable=False)
    width = Column(Integer)
    height = Column(Integer)
    duration = Column(Float)  # For videos, in seconds
    safety = Column(String(10), default="safe")  # safe, sketchy, unsafe
    source = Column(Text)
    # 64-bit perceptual hash (dHash) as 16-char hex, for near-duplicate
    # detection and "find similar". Null = not yet computed; "" = unhashable.
    phash = Column(String(16), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # Soft-delete marker so deletions can propagate through sync (tombstone).
    deleted_at = Column(DateTime, nullable=True, index=True)

    # Relationships
    tags = relationship("Tag", secondary=PostTag, back_populates="posts")
    notes = relationship("Note", back_populates="post", cascade="all, delete-orphan")
    comments = relationship("Comment", back_populates="post", cascade="all, delete-orphan")
    pools = relationship("PoolPost", back_populates="post", cascade="all, delete-orphan")
    # One row per user who has favorited this post - each user favorites
    # independently, so this is a list even though most posts have 0 or 1.
    favorites = relationship("Favorite", back_populates="post", cascade="all, delete-orphan")
    ai_analyses = relationship("PostAiAnalysis", back_populates="post", cascade="all, delete-orphan")

    @property
    def content_path(self):
        """Path to the original file."""
        # extension already includes the dot (e.g., ".jpg")
        return f"{self.sha256[:2]}/{self.sha256}{self.extension}"

    @property
    def thumb_path(self):
        """Path to the thumbnail."""
        return f"{self.sha256[:2]}/{self.sha256}.jpg"

    def to_dict(self, current_user_id: int | None = None):
        return {
            "id": self.id,
            "sha256": self.sha256,
            "filename": self.filename,
            "extension": self.extension,
            "fileSize": self.file_size,
            "width": self.width,
            "height": self.height,
            "duration": self.duration,
            "safety": self.safety,
            "source": self.source,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
            "deletedAt": self.deleted_at.isoformat() if self.deleted_at else None,
            "tags": [tag.name for tag in self.tags] if self.tags else [],
            # Category/colour/count for the grouped tag sidebar. Post queries
            # eager-load Tag.category for this; _tag_detail() degrades to an
            # uncategorised entry rather than raising if some caller forgets,
            # because lazy-loading here would fail under async.
            "tagDetails": [_tag_detail(tag) for tag in self.tags] if self.tags else [],
            "isFavorited": (
                current_user_id is not None
                and any(f.user_id == current_user_id for f in (self.favorites or []))
            ),
            "contentUrl": f"/api/media/posts/{self.content_path}",
            "thumbUrl": f"/api/media/thumbs/{self.thumb_path}",
        }
