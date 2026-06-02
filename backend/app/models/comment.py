import uuid as uuid_lib
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from ..database import Base


def _new_uuid() -> str:
    return str(uuid_lib.uuid4())


class Comment(Base):
    __tablename__ = "comments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Stable cross-device identity for sync.
    uuid = Column(String(36), unique=True, nullable=False, index=True, default=_new_uuid)
    post_id = Column(Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    post = relationship("Post", back_populates="comments")

    def to_dict(self):
        return {
            "id": self.id,
            "uuid": self.uuid,
            "postId": self.post_id,
            "text": self.text,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }
