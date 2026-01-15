from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, Float, DateTime, ForeignKey, Table
from sqlalchemy.orm import relationship

from ..database import Base


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
    sha256 = Column(String(64), unique=True, nullable=False, index=True)
    filename = Column(String(255), nullable=False)
    extension = Column(String(10), nullable=False)
    file_size = Column(Integer, nullable=False)
    width = Column(Integer)
    height = Column(Integer)
    duration = Column(Float)  # For videos, in seconds
    safety = Column(String(10), default="safe")  # safe, sketchy, unsafe
    source = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    tags = relationship("Tag", secondary=PostTag, back_populates="posts")
    notes = relationship("Note", back_populates="post", cascade="all, delete-orphan")
    comments = relationship("Comment", back_populates="post", cascade="all, delete-orphan")
    pools = relationship("PoolPost", back_populates="post", cascade="all, delete-orphan")
    favorite = relationship("Favorite", back_populates="post", uselist=False, cascade="all, delete-orphan")

    @property
    def content_path(self):
        """Path to the original file."""
        # extension already includes the dot (e.g., ".jpg")
        return f"{self.sha256[:2]}/{self.sha256}{self.extension}"

    @property
    def thumb_path(self):
        """Path to the thumbnail."""
        return f"{self.sha256[:2]}/{self.sha256}.jpg"

    def to_dict(self):
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
            "tags": [tag.name for tag in self.tags] if self.tags else [],
            "isFavorited": self.favorite is not None,
            "contentUrl": f"/api/media/posts/{self.content_path}",
            "thumbUrl": f"/api/media/thumbs/{self.thumb_path}",
        }
