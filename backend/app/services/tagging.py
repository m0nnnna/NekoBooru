"""Shared tag application helpers.

Routers, imports, and auto-tag jobs all go through this module so aliases,
implications, usage counts, categories, and updated_at behave consistently.
"""
from __future__ import annotations

import re
from datetime import datetime

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import Tag, TagAlias, TagCategory, TagImplication
from ..models.post import PostTag


def qualifier_display_name(raw: str) -> str | None:
    """Keep the booru spelling when a qualified tag is typed or imported.

    normalize_tag() flattens ``evie_(stellar_blade)`` to ``evie_stellar_blade``,
    which is what makes both spellings find each other in search - but it also
    loses the parentheses the display name exists to preserve. Recover them from
    the raw input so hand-typed booru tags read the same as tagger-supplied
    ones. Returns None for ordinary tags, which keeps the existing
    "underscores become spaces" fallback.
    """
    text = re.sub(r"\s+", " ", str(raw or "").strip().lower())
    if "(" not in text or ")" not in text:
        return None
    return text.replace("_", " ").strip()


def normalize_tag(raw: str) -> str:
    tag = re.sub(r"\s+", "_", str(raw or "").strip().lower())
    tag = re.sub(r"[^\w:.-]+", "_", tag)
    tag = re.sub(r"_+", "_", tag)
    return tag.strip("_")


async def process_tags_for_post(
    db: AsyncSession,
    post_id: int,
    tag_names: list[str],
    *,
    categories: dict[str, str] | None = None,
    display_names: dict[str, str] | None = None,
):
    """Append tags to a post using direct SQL inserts."""
    if not tag_names:
        return

    categories = {normalize_tag(k): v for k, v in (categories or {}).items()}
    # Source spellings from the tagger, e.g. "miyu (blue archive)" for the
    # stored "miyu_blue_archive". Display only; "name" remains the key.
    display_names = {normalize_tag(k): v for k, v in (display_names or {}).items()}
    resolved_tag_ids = set()

    cat_result = await db.execute(select(TagCategory))
    category_by_name = {cat.name: cat for cat in cat_result.scalars().all()}
    default_cat_id = category_by_name.get("general").id if category_by_name.get("general") else 1

    for raw_name in tag_names:
        tag_name = normalize_tag(raw_name)
        if not tag_name:
            continue

        alias_result = await db.execute(
            select(TagAlias).options(selectinload(TagAlias.target)).where(TagAlias.alias_name == tag_name)
        )
        alias = alias_result.scalars().first()
        if alias and alias.target:
            tag_name = alias.target.name

        category_name = categories.get(tag_name, "general")
        category = category_by_name.get(category_name) or category_by_name.get("general")
        category_id = category.id if category else default_cat_id

        tag_result = await db.execute(select(Tag).where(Tag.name == tag_name))
        tag = tag_result.scalars().first()

        display_name = display_names.get(tag_name) or qualifier_display_name(raw_name)
        if not tag:
            tag = Tag(name=tag_name, category_id=category_id, display_name=display_name)
            db.add(tag)
            await db.flush()
        else:
            if tag.category_id == default_cat_id and category_id != default_cat_id:
                tag.category_id = category_id
            # Backfill older rows, but never overwrite a spelling already stored.
            if display_name and not tag.display_name:
                tag.display_name = display_name

        resolved_tag_ids.add(tag.id)

        impl_result = await db.execute(
            select(TagImplication).where(TagImplication.antecedent_id == tag.id)
        )
        for impl in impl_result.scalars().all():
            resolved_tag_ids.add(impl.consequent_id)

    for tag_id in resolved_tag_ids:
        existing = await db.execute(
            select(PostTag).where(
                PostTag.c.post_id == post_id,
                PostTag.c.tag_id == tag_id,
            )
        )
        if not existing.first():
            await db.execute(insert(PostTag).values(post_id=post_id, tag_id=tag_id))
            await db.execute(
                Tag.__table__.update().where(Tag.id == tag_id).values(
                    usage_count=Tag.usage_count + 1
                )
            )


async def replace_tags_for_post(
    db: AsyncSession,
    post,
    tag_names: list[str],
    *,
    categories: dict[str, str] | None = None,
    display_names: dict[str, str] | None = None,
):
    """Replace a post's tag set and adjust usage counts."""
    result = await db.execute(
        select(Tag).join(PostTag, PostTag.c.tag_id == Tag.id).where(PostTag.c.post_id == post.id)
    )
    old_tags = list(result.scalars().all())
    for tag in old_tags:
        tag.usage_count = max(0, (tag.usage_count or 0) - 1)

    await db.execute(delete(PostTag).where(PostTag.c.post_id == post.id))
    await process_tags_for_post(db, post.id, tag_names, categories=categories, display_names=display_names)
    post.updated_at = datetime.utcnow()
