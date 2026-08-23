from datetime import datetime
from sqlalchemy import Column, Integer, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from ..database import Base


class Favorite(Base):
    __tablename__ = "favorites"
    # Per-user uniqueness (a shared-library viewer favorites independently of
    # the owner), not per-post - see the favorites-table rebuild in
    # database.py's _migrate() for how a live install gets here from the old
    # post-only UNIQUE constraint.
    __table_args__ = (UniqueConstraint("post_id", "user_id", name="uq_favorites_post_user"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    post_id = Column(Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    # Nullable only for rows created before the multi-user migration ran.
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    post = relationship("Post", back_populates="favorite")

    def to_dict(self):
        return {
            "id": self.id,
            "postId": self.post_id,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }
