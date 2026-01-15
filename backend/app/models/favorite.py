from datetime import datetime
from sqlalchemy import Column, Integer, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from ..database import Base


class Favorite(Base):
    __tablename__ = "favorites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    post_id = Column(Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    post = relationship("Post", back_populates="favorite")

    def to_dict(self):
        return {
            "id": self.id,
            "postId": self.post_id,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }
