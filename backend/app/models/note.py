from datetime import datetime
from sqlalchemy import Column, Integer, Float, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from ..database import Base


class Note(Base):
    __tablename__ = "notes"

    id = Column(Integer, primary_key=True, autoincrement=True)
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
            "postId": self.post_id,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "text": self.text,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }
