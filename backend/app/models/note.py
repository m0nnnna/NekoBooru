import uuid as uuid_lib
from datetime import datetime
from sqlalchemy import Column, Integer, Float, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from ..database import Base


def _new_uuid() -> str:
    return str(uuid_lib.uuid4())


class Note(Base):
    __tablename__ = "notes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Stable cross-device identity for sync.
    uuid = Column(String(36), unique=True, nullable=False, index=True, default=_new_uuid)
    post_id = Column(Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    x = Column(Float, nullable=False)  # X position as percentage (0-100)
    y = Column(Float, nullable=False)  # Y position as percentage (0-100)
    width = Column(Float, nullable=False)  # Width as percentage (0-100)
    height = Column(Float, nullable=False)  # Height as percentage (0-100)
    text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    post = relationship("Post", back_populates="notes")

    def to_dict(self):
        return {
            "id": self.id,
            "uuid": self.uuid,
            "postId": self.post_id,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "text": self.text,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }
