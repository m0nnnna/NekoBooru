from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from ..database import Base


class Pool(Base):
    __tablename__ = "pools"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    posts = relationship("PoolPost", back_populates="pool", cascade="all, delete-orphan", order_by="PoolPost.order")

    def to_dict(self):
        # Safely get post count - handle case where posts relationship isn't loaded
        try:
            post_count = len(self.posts) if self.posts else 0
        except (AttributeError, RuntimeError):
            # Relationship not loaded or lazy loading failed
            post_count = 0
        
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "postCount": post_count,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }


class PoolPost(Base):
    __tablename__ = "pool_posts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    pool_id = Column(Integer, ForeignKey("pools.id", ondelete="CASCADE"), nullable=False)
    post_id = Column(Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    order = Column(Integer, default=0)

    pool = relationship("Pool", back_populates="posts")
    post = relationship("Post", back_populates="pools")
