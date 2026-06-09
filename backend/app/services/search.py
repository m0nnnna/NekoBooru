import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from sqlalchemy import select, and_, or_, not_, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import Post, Tag, PostTag, Favorite, PoolPost
from .ai_analysis import semantic_analysis_condition


class TokenType(Enum):
    TAG = "tag"
    NEGATED_TAG = "negated_tag"
    OR = "or"
    FILTER = "filter"
    NEGATED_FILTER = "negated_filter"


@dataclass
class Token:
    type: TokenType
    value: str
    filter_key: Optional[str] = None
    filter_op: Optional[str] = None


FILTER_KEYS = {
    "rating",
    "safety",
    "width",
    "height",
    "fav",
    "favorite",
    "pool",
    "type",
    "sort",
}


def _is_filter_key(key: str) -> bool:
    return key.lower() in FILTER_KEYS


def _parse_filter(part: str, token_type: TokenType) -> Token | None:
    key, _, value = part.partition(":")
    if not key or not _is_filter_key(key):
        return None

    op = "="
    if value.startswith(">="):
        op = ">="
        value = value[2:]
    elif value.startswith("<="):
        op = "<="
        value = value[2:]
    elif value.startswith(">"):
        op = ">"
        value = value[1:]
    elif value.startswith("<"):
        op = "<"
        value = value[1:]
    return Token(token_type, value, filter_key=key.lower(), filter_op=op)


def tokenize(query: str) -> list[Token]:
    """Tokenize search query into tokens."""
    tokens = []
    parts = query.split()

    i = 0
    while i < len(parts):
        part = parts[i]

        # Check for OR operator
        if part.upper() == "OR" and i > 0 and i < len(parts) - 1:
            tokens.append(Token(TokenType.OR, "OR"))
        # Check for negated filter (e.g., -safety:unsafe)
        elif part.startswith("-") and ":" in part[1:]:
            negated_part = part[1:]
            token = _parse_filter(negated_part, TokenType.NEGATED_FILTER)
            if token:
                tokens.append(token)
            else:
                tokens.append(Token(TokenType.NEGATED_TAG, part[1:]))
        # Check for negated tag
        elif part.startswith("-"):
            tokens.append(Token(TokenType.NEGATED_TAG, part[1:]))
        # Check for filter (key:value)
        elif ":" in part:
            token = _parse_filter(part, TokenType.FILTER)
            tokens.append(token or Token(TokenType.TAG, part))
        # Regular tag
        else:
            tokens.append(Token(TokenType.TAG, part))

        i += 1

    return tokens


def _order_column(sort: str):
    """Map a sort key to the Post column it orders by."""
    return {
        "date": Post.created_at,
        "id": Post.id,
        "size": Post.file_size,
        "width": Post.width,
        "height": Post.height,
    }.get(sort, Post.created_at)


def build_conditions(query: str) -> list:
    """Translate a search query into a list of SQLAlchemy WHERE conditions.

    Shared by :func:`search_posts` and :func:`get_post_neighbors` so the gallery
    list and the prev/next navigation always agree on which posts match.
    """
    tokens = tokenize(query) if query else []

    # Track conditions. Always exclude soft-deleted posts.
    and_conditions = [Post.deleted_at.is_(None)]
    or_groups = []
    current_or_group = []

    for token in tokens:
        if token.type == TokenType.TAG:
            subq = select(PostTag.c.post_id).join(Tag).where(Tag.name == token.value)
            condition = Post.id.in_(subq)
            if current_or_group:
                current_or_group.append(condition)
            else:
                and_conditions.append(condition)

        elif token.type == TokenType.NEGATED_TAG:
            subq = select(PostTag.c.post_id).join(Tag).where(Tag.name == token.value)
            and_conditions.append(not_(Post.id.in_(subq)))

        elif token.type == TokenType.OR:
            if and_conditions:
                current_or_group = [and_conditions.pop()]

        elif token.type == TokenType.FILTER:
            condition = apply_filter(token)
            if condition is not None:
                and_conditions.append(condition)

        elif token.type == TokenType.NEGATED_FILTER:
            condition = apply_filter(token)
            if condition is not None:
                and_conditions.append(not_(condition))

        if current_or_group and token.type not in (TokenType.OR,) and token.type == TokenType.TAG:
            if len(current_or_group) > 1:
                or_groups.append(or_(*current_or_group))
                current_or_group = []

    if current_or_group:
        or_groups.append(or_(*current_or_group))

    return and_conditions + or_groups


def _semantic_search_tokens(query: str) -> list[str]:
    tokens = tokenize(query) if query else []
    words = []
    for token in tokens:
        if token.type == TokenType.TAG:
            value = token.value.strip().lower()
            if value and not _is_filter_key(value.split(":", 1)[0]):
                words.append(value)
            continue
        if token.type in {TokenType.FILTER, TokenType.NEGATED_FILTER} and token.filter_key == "safety":
            continue
        return []
    if not words:
        return []
    return [word for word in words if len(word) >= 2]


def _escape_like(value: str) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )


def _semantic_tag_name_condition(normalized: str):
    escaped = _escape_like(normalized)
    name = func.lower(Tag.name)
    return or_(
        name == normalized,
        name.like(f"{escaped}\\_%", escape="\\"),
        name.like(f"%\\_{escaped}", escape="\\"),
        name.like(f"%\\_{escaped}\\_%", escape="\\"),
    )


async def _semantic_expansion_conditions(session: AsyncSession, query: str) -> list:
    """Expand plain-language search words into known tags and saved AI analysis.

    This never runs a model at search time. Each user word becomes an OR group
    of matching tag names and persisted Qwen analysis text; groups are ANDed
    together so "pink bikini" favors posts containing both concepts.
    """
    words = _semantic_search_tokens(query)
    if not words:
        return []

    groups = []
    for word in words[:6]:
        normalized = re.sub(r"[^\w:.-]+", "_", word).strip("_")
        if not normalized:
            continue
        rows = (
            await session.execute(
                select(Tag.name)
                .where(_semantic_tag_name_condition(normalized))
                .order_by(Tag.usage_count.desc(), Tag.name.asc())
                .limit(24)
            )
        ).scalars().all()
        tag_names = [name for name in rows if name]
        conditions = []
        if tag_names:
            subq = select(PostTag.c.post_id).join(Tag).where(Tag.name.in_(tag_names))
            conditions.append(Post.id.in_(subq))
        analysis_condition = semantic_analysis_condition(normalized)
        if analysis_condition is not None:
            conditions.append(analysis_condition)
        if conditions:
            groups.append(or_(*conditions))
    return groups


async def get_post_neighbors(
    session: AsyncSession,
    post_id: int,
    query: str = "",
    sort: str = "date",
    sort_order: str = "desc",
    semantic_search: bool = False,
) -> dict:
    """Return the prev/next post ids around ``post_id`` within a filtered view.

    "prev" and "next" follow display order: prev is the post shown before this
    one in the list, next is the one after. So for the default newest-first
    view, the latest post has no prev (left does nothing) and right advances to
    the next-older post.
    """
    order_col = _order_column(sort)
    current = (
        await session.execute(
            select(Post.id, order_col).where(
                Post.id == post_id, Post.deleted_at.is_(None)
            )
        )
    ).first()
    if not current:
        return {"prev": None, "next": None}

    cur_id, cur_val = current[0], current[1]
    conditions = build_conditions(query)
    if semantic_search:
        semantic_conditions = await _semantic_expansion_conditions(session, query)
        if semantic_conditions:
            conditions = [Post.deleted_at.is_(None), *semantic_conditions]
    descending = sort_order != "asc"

    # Strictly-before / strictly-after in value, breaking ties by id.
    less = or_(order_col < cur_val, and_(order_col == cur_val, Post.id < cur_id))
    greater = or_(order_col > cur_val, and_(order_col == cur_val, Post.id > cur_id))

    async def first_id(extra, ordering):
        stmt = select(Post.id).where(and_(*conditions, extra)).order_by(*ordering).limit(1)
        return (await session.execute(stmt)).scalars().first()

    if descending:  # list is (val desc, id desc): next = smaller, prev = larger
        nxt = await first_id(less, (order_col.desc(), Post.id.desc()))
        prev = await first_id(greater, (order_col.asc(), Post.id.asc()))
    else:  # list is (val asc, id asc): next = larger, prev = smaller
        nxt = await first_id(greater, (order_col.asc(), Post.id.asc()))
        prev = await first_id(less, (order_col.desc(), Post.id.desc()))

    return {"prev": prev, "next": nxt}


async def search_posts(
    session: AsyncSession,
    query: str = "",
    page: int = 1,
    per_page: int = 42,
    sort: str = "date",
    sort_order: str = "desc",
    semantic_search: bool = False,
) -> tuple[list[Post], int]:
    """Search posts with tag-based query syntax."""
    # Base query with eager loading
    stmt = select(Post).options(
        selectinload(Post.tags),
        selectinload(Post.favorite),
    )

    all_conditions = build_conditions(query)
    if semantic_search:
        semantic_conditions = await _semantic_expansion_conditions(session, query)
        if semantic_conditions:
            all_conditions = [Post.deleted_at.is_(None), *semantic_conditions]
    if all_conditions:
        stmt = stmt.where(and_(*all_conditions))

    # Get total count
    count_stmt = select(func.count(Post.id))
    if all_conditions:
        count_stmt = count_stmt.where(and_(*all_conditions))
    total_result = await session.execute(count_stmt)
    total = total_result.scalar() or 0

    # Apply sorting. Break ties by id (same direction) so the order is stable and
    # matches get_post_neighbors() exactly.
    order_col = _order_column(sort)
    if sort_order == "asc":
        stmt = stmt.order_by(order_col.asc(), Post.id.asc())
    else:
        stmt = stmt.order_by(order_col.desc(), Post.id.desc())

    # Apply pagination
    stmt = stmt.offset((page - 1) * per_page).limit(per_page)

    result = await session.execute(stmt)
    posts = list(result.scalars().all())

    return posts, total


def apply_filter(token: Token):
    """Apply a filter token to the query."""
    key = token.filter_key
    value = token.filter_value if hasattr(token, "filter_value") else token.value
    op = token.filter_op

    if key == "rating" or key == "safety":
        return Post.safety == value

    elif key == "width":
        try:
            val = int(value)
            if op == ">=":
                return Post.width >= val
            elif op == "<=":
                return Post.width <= val
            elif op == ">":
                return Post.width > val
            elif op == "<":
                return Post.width < val
            else:
                return Post.width == val
        except ValueError:
            return None

    elif key == "height":
        try:
            val = int(value)
            if op == ">=":
                return Post.height >= val
            elif op == "<=":
                return Post.height <= val
            elif op == ">":
                return Post.height > val
            elif op == "<":
                return Post.height < val
            else:
                return Post.height == val
        except ValueError:
            return None

    elif key == "fav" or key == "favorite":
        if value.lower() in ("true", "yes", "1"):
            return Post.id.in_(select(Favorite.post_id))
        else:
            return not_(Post.id.in_(select(Favorite.post_id)))

    elif key == "pool":
        try:
            pool_id = int(value)
            return Post.id.in_(select(PoolPost.post_id).where(PoolPost.pool_id == pool_id))
        except ValueError:
            return None

    elif key == "type":
        if value == "image":
            return Post.extension.in_([".jpg", ".jpeg", ".png", ".webp"])
        elif value == "gif":
            return Post.extension == ".gif"
        elif value == "video":
            return Post.extension.in_([".webm", ".mp4"])

    elif key == "sort":
        # Sorting is handled separately
        return None

    return None
