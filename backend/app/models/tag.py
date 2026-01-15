from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from ..database import Base
from .post import PostTag


class TagCategory(Base):
    __tablename__ = "tag_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(50), unique=True, nullable=False)
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

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
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

    id = Column(Integer, primary_key=True, autoincrement=True)
    alias_name = Column(String(255), unique=True, nullable=False, index=True)
    target_id = Column(Integer, ForeignKey("tags.id", ondelete="CASCADE"), nullable=False)

    target = relationship("Tag", back_populates="aliases")

    def to_dict(self):
        return {
            "id": self.id,
            "aliasName": self.alias_name,
            "targetName": self.target.name if self.target else None,
        }
