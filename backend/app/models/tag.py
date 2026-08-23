from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from ..database import Base
from .post import PostTag


class TagCategory(Base):
    __tablename__ = "tag_categories"
    __table_args__ = (UniqueConstraint("owner_id", "name", name="uq_tag_categories_owner_name"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Nullable only for rows created before the multi-user migration ran; see
    # the backfill in database.py's _migrate().
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String(50), nullable=False)
    color = Column(String(7), default="#808080")  # Hex color
    order = Column(Integer, default=0)

    tags = relationship("Tag", back_populates="category")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "order": self.order,
        }


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("owner_id", "name", name="uq_tags_owner_name"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Nullable only for rows created before the multi-user migration ran; see
    # the backfill in database.py's _migrate(). Tags are private to the
    # library that created them, visible to another user only through a
    # LibraryShare - the same model as Post.owner_id.
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    # The source spelling before normalize_tag() flattened it, e.g.
    # "miyu (blue archive)" for the stored "miyu_blue_archive". Display only -
    # "name" stays the key, so search and dedupe are unaffected. Null for tags
    # that arrived without one (hand-typed, older rows), and the UI falls back
    # to swapping underscores for spaces.
    display_name = Column(String(255), nullable=True)
    category_id = Column(Integer, ForeignKey("tag_categories.id"), default=1)
    usage_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    category = relationship("TagCategory", back_populates="tags")
    posts = relationship("Post", secondary=PostTag, back_populates="tags")
    implications_from = relationship(
        "TagImplication",
        foreign_keys="TagImplication.antecedent_id",
        back_populates="antecedent",
        cascade="all, delete-orphan",
    )
    implications_to = relationship(
        "TagImplication",
        foreign_keys="TagImplication.consequent_id",
        back_populates="consequent",
        cascade="all, delete-orphan",
    )
    aliases = relationship("TagAlias", back_populates="target", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "displayName": self.display_name or self.name.replace("_", " "),
            "category": self.category.name if self.category else "general",
            "categoryColor": self.category.color if self.category else "#808080",
            "usageCount": self.usage_count,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }


class TagImplication(Base):
    __tablename__ = "tag_implications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    antecedent_id = Column(Integer, ForeignKey("tags.id", ondelete="CASCADE"), nullable=False)
    consequent_id = Column(Integer, ForeignKey("tags.id", ondelete="CASCADE"), nullable=False)

    antecedent = relationship("Tag", foreign_keys=[antecedent_id], back_populates="implications_from")
    consequent = relationship("Tag", foreign_keys=[consequent_id], back_populates="implications_to")

    def to_dict(self):
        return {
            "id": self.id,
            "antecedent": self.antecedent.name if self.antecedent else None,
            "consequent": self.consequent.name if self.consequent else None,
        }


class TagAlias(Base):
    __tablename__ = "tag_aliases"
    __table_args__ = (UniqueConstraint("owner_id", "alias_name", name="uq_tag_aliases_owner_alias"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Denormalized from the target tag's owner so alias lookups (on the hot
    # tagging path) don't need a join. Nullable only pre-migration, same as
    # Tag.owner_id.
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    alias_name = Column(String(255), nullable=False, index=True)
    target_id = Column(Integer, ForeignKey("tags.id", ondelete="CASCADE"), nullable=False)

    target = relationship("Tag", back_populates="aliases")

    def to_dict(self):
        return {
            "id": self.id,
            "aliasName": self.alias_name,
            "targetName": self.target.name if self.target else None,
        }
