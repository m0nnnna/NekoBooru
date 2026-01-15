import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from sqlalchemy import select, and_, or_, not_, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import Post, Tag, PostTag, Favorite, PoolPost


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
            key, _, value = negated_part.partition(":")
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
            tokens.append(Token(TokenType.NEGATED_FILTER, value, filter_key=key.lower(), filter_op=op))
        # Check for negated tag
        elif part.startswith("-"):
            tokens.append(Token(TokenType.NEGATED_TAG, part[1:]))
        # Check for filter (key:value)
        elif ":" in part:
            key, _, value = part.partition(":")
            # Check for comparison operators
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
            tokens.append(Token(TokenType.FILTER, value, filter_key=key.lower(), filter_op=op))
        # Regular tag
        else:
            tokens.append(Token(TokenType.TAG, part))

        i += 1

    return tokens


async def search_posts(
    session: AsyncSession,
    query: str = "",
    page: int = 1,
    per_page: int = 40,
    sort: str = "date",
    sort_order: str = "desc",
) -> tuple[list[Post], int]:
    """Search posts with tag-based query syntax."""
    tokens = tokenize(query) if query else []

    # Base query with eager loading
    stmt = select(Post).options(
        selectinload(Post.tags),
        selectinload(Post.favorite),
    )

    # Track conditions
    and_conditions = []
    or_groups = []
    current_or_group = []

    for token in tokens:
        if token.type == TokenType.TAG:
            # Tag must be present
            subq = select(PostTag.c.post_id).join(Tag).where(Tag.name == token.value)
            condition = Post.id.in_(subq)
            if current_or_group:
                current_or_group.append(condition)
            else:
                and_conditions.append(condition)

        elif token.type == TokenType.NEGATED_TAG:
            # Tag must NOT be present
            subq = select(PostTag.c.post_id).join(Tag).where(Tag.name == token.value)
            and_conditions.append(not_(Post.id.in_(subq)))

        elif token.type == TokenType.OR:
            # Start collecting for OR group
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

        # If we have an OR group and encounter something else, close it
        if current_or_group and token.type not in (TokenType.OR,) and token.type == TokenType.TAG:
            if len(current_or_group) > 1:
                or_groups.append(or_(*current_or_group))
                current_or_group = []

    # Handle any remaining OR group
    if current_or_group:
        or_groups.append(or_(*current_or_group))

    # Combine all conditions
    all_conditions = and_conditions + or_groups
    if all_conditions:
        stmt = stmt.where(and_(*all_conditions))

    # Get total count
    count_stmt = select(func.count(Post.id))
    if all_conditions:
        count_stmt = count_stmt.where(and_(*all_conditions))
    total_result = await session.execute(count_stmt)
    total = total_result.scalar() or 0

    # Apply sorting
    if sort == "date":
        order_col = Post.created_at
    elif sort == "id":
        order_col = Post.id
    elif sort == "size":
        order_col = Post.file_size
    elif sort == "width":
        order_col = Post.width
    elif sort == "height":
        order_col = Post.height
    else:
        order_col = Post.created_at

    if sort_order == "asc":
        stmt = stmt.order_by(order_col.asc())
    else:
        stmt = stmt.order_by(order_col.desc())

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
