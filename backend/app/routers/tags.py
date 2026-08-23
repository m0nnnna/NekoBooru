from typing import Optional
import re
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..dependencies import get_current_user
from ..models import Tag, TagCategory, TagImplication, TagAlias, User
from ..services.auth import visible_owner_ids

router = APIRouter(prefix="/api", tags=["tags"])


def _escape_like(value: str) -> str:
    """Escape user text for SQL LIKE patterns that use backslash escaping."""
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )


def _normalize_tag_query(value: str) -> str:
    return re.sub(r"\s+", "_", str(value or "").strip().lower()).strip("_")


def _tag_name_search_condition(q: str):
    normalized = _normalize_tag_query(q)
    if not normalized:
        return None
    pattern = _escape_like(normalized)
    name = func.lower(Tag.name)
    return name.like(f"%{pattern}%", escape="\\")


def _tag_name_autocomplete_condition(q: str, name_parts: bool = False):
    normalized = _normalize_tag_query(q)
    if not normalized:
        return None, None

    pattern = _escape_like(normalized)
    name = func.lower(Tag.name)
    if name_parts:
        match_condition = name.like(f"%{pattern}%", escape="\\")
    else:
        match_condition = (
            (name == normalized)
            | name.like(f"{pattern}%", escape="\\")
            | name.like(f"%\\_{pattern}", escape="\\")
            | name.like(f"%\\_{pattern}\\_%", escape="\\")
        )
    rank = case(
        (name == normalized, 0),
        (name.like(f"{pattern}\\_%", escape="\\"), 1),
        (name.like(f"%\\_{pattern}", escape="\\"), 2),
        (name.like(f"%\\_{pattern}\\_%", escape="\\"), 3),
        (name.like(f"{pattern}%", escape="\\"), 4),
        else_=5,
    )
    return match_condition, rank


class CreateTagRequest(BaseModel):
    name: str
    category: str = "general"


class UpdateTagRequest(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None


class CreateImplicationRequest(BaseModel):
    antecedent: str  # Source tag
    consequent: str  # Implied tag


class CreateAliasRequest(BaseModel):
    alias: str  # Alias name
    target: str  # Canonical tag name


@router.get("/tags")
async def list_tags(
    q: str = Query("", description="Search query"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    sort: str = Query("usage"),  # usage, name, date
    order: str = Query("desc"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List tags with search and pagination, scoped to what this user can see
    (their own library plus anything shared with them)."""
    owner_ids = await visible_owner_ids(db, current_user)
    stmt = select(Tag).options(selectinload(Tag.category)).where(Tag.owner_id.in_(owner_ids))

    # Apply search filter
    if q:
        condition = _tag_name_search_condition(q)
        if condition is not None:
            stmt = stmt.where(condition)
        else:
            stmt = stmt.where(False)

    # Get total count
    count_stmt = select(func.count(Tag.id)).where(Tag.owner_id.in_(owner_ids))
    if q:
        condition = _tag_name_search_condition(q)
        if condition is not None:
            count_stmt = count_stmt.where(condition)
        else:
            count_stmt = count_stmt.where(False)
    total_result = await db.execute(count_stmt)
    total = total_result.scalar() or 0

    # Apply sorting
    if sort == "usage":
        order_col = Tag.usage_count
    elif sort == "name":
        order_col = Tag.name
    else:
        order_col = Tag.created_at

    if order == "asc":
        stmt = stmt.order_by(order_col.asc())
    else:
        stmt = stmt.order_by(order_col.desc())

    # Apply pagination
    stmt = stmt.offset((page - 1) * limit).limit(limit)

    result = await db.execute(stmt)
    tags = list(result.scalars().all())

    return {
        "results": [t.to_dict() for t in tags],
        "total": total,
        "page": page,
        "limit": limit,
    }


@router.get("/tags/autocomplete")
async def autocomplete_tags(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=50),
    name_parts: bool = Query(False, alias="nameParts"),
    include_remote: bool = Query(False, alias="includeRemote"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get tag suggestions for autocomplete.

    With ``includeRemote`` the local matches are topped up with suggestions from
    public boorus for tags this library does not have yet - the case local
    autocomplete cannot help with at all. Remote rows carry ``remote: true`` and
    the source board's own category, and only appear when the setting is on.
    """
    match_condition, rank = _tag_name_autocomplete_condition(q, name_parts=name_parts)
    if match_condition is None:
        return []

    owner_ids = await visible_owner_ids(db, current_user)
    stmt = (
        select(Tag)
        .options(selectinload(Tag.category))
        .where(match_condition, Tag.owner_id.in_(owner_ids))
        .order_by(rank.asc(), Tag.usage_count.desc(), Tag.name.asc())
        .limit(limit)
    )

    result = await db.execute(stmt)
    tags = list(result.scalars().all())
    rows = [t.to_dict() for t in tags]
    if not include_remote or len(rows) >= limit:
        return rows

    from ..services.auto_tagger import load_options

    if not getattr(load_options(), "booruSuggestEnabled", False):
        return rows

    from ..services.booru_suggest import suggest_tags

    known = {row["name"] for row in rows}
    remote = [row for row in await suggest_tags(q, limit=limit) if row["name"] not in known]
    if remote:
        # Colour them from this library's own palette so a character reads as a
        # character whether the row came from here or from Danbooru.
        colors = {
            category.name: category.color
            for category in (
                await db.execute(select(TagCategory).where(TagCategory.owner_id == current_user.id))
            ).scalars().all()
        }
        for row in remote:
            row["categoryColor"] = colors.get(row["category"], "#808080")
    # Your own tags always rank above a remote guess, and a remote row for a tag
    # you already have would just be a duplicate with a stranger's usage count.
    rows.extend(remote)
    return rows[:limit]


@router.get("/tags/{tag_name}")
async def get_tag(tag_name: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get a single tag by name - this user's own, or from a library shared with them."""
    owner_ids = await visible_owner_ids(db, current_user)
    result = await db.execute(
        select(Tag)
        .options(
            selectinload(Tag.category),
            selectinload(Tag.implications_from).selectinload(TagImplication.consequent),
            selectinload(Tag.implications_to).selectinload(TagImplication.antecedent),
            selectinload(Tag.aliases),
        )
        .where(Tag.name == tag_name, Tag.owner_id.in_(owner_ids))
    )
    tag = result.scalars().first()

    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    data = tag.to_dict()
    data["implications"] = [impl.consequent.name for impl in tag.implications_from]
    data["impliedBy"] = [impl.antecedent.name for impl in tag.implications_to]
    data["aliases"] = [alias.alias_name for alias in tag.aliases]

    return data


@router.post("/tags")
async def create_tag(
    request: CreateTagRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Create a new tag in this user's own library."""
    # Check if tag already exists
    existing = await db.execute(
        select(Tag).where(Tag.name == request.name.lower(), Tag.owner_id == current_user.id)
    )
    if existing.scalars().first():
        raise HTTPException(status_code=409, detail="Tag already exists")

    # Get category
    cat_result = await db.execute(
        select(TagCategory).where(TagCategory.name == request.category, TagCategory.owner_id == current_user.id)
    )
    category = cat_result.scalars().first()

    if not category:
        raise HTTPException(status_code=400, detail=f"Unknown category: {request.category}")

    tag = Tag(owner_id=current_user.id, name=request.name.lower().replace(" ", "_"), category_id=category.id)
    db.add(tag)
    await db.commit()
    await db.refresh(tag, ["category"])

    return tag.to_dict()


@router.put("/tags/{tag_name}")
async def update_tag(
    tag_name: str,
    request: UpdateTagRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update a tag in this user's own library."""
    result = await db.execute(
        select(Tag)
        .options(selectinload(Tag.category))
        .where(Tag.name == tag_name, Tag.owner_id == current_user.id)
    )
    tag = result.scalars().first()

    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    if request.name is not None:
        # Check for conflicts
        new_name = request.name.lower().replace(" ", "_")
        if new_name != tag.name:
            existing = await db.execute(
                select(Tag).where(Tag.name == new_name, Tag.owner_id == current_user.id)
            )
            if existing.scalars().first():
                raise HTTPException(status_code=409, detail="Tag name already taken")
            tag.name = new_name

    if request.category is not None:
        cat_result = await db.execute(
            select(TagCategory).where(TagCategory.name == request.category, TagCategory.owner_id == current_user.id)
        )
        category = cat_result.scalars().first()
        if not category:
            raise HTTPException(status_code=400, detail=f"Unknown category: {request.category}")
        tag.category_id = category.id

    await db.commit()
    await db.refresh(tag, ["category"])
    return tag.to_dict()


@router.delete("/tags/{tag_name}")
async def delete_tag(
    tag_name: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Delete a tag from this user's own library."""
    result = await db.execute(select(Tag).where(Tag.name == tag_name, Tag.owner_id == current_user.id))
    tag = result.scalars().first()

    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    await db.delete(tag)
    await db.commit()
    return {"success": True}


# Tag Categories
@router.get("/tag-categories")
async def list_categories(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """List this user's own tag categories - the palette they tag against."""
    result = await db.execute(
        select(TagCategory).where(TagCategory.owner_id == current_user.id).order_by(TagCategory.order)
    )
    categories = list(result.scalars().all())
    return [c.to_dict() for c in categories]


# Tag Implications
@router.get("/tag-implications")
async def list_implications(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List this user's own tag implications."""
    stmt = (
        select(TagImplication)
        .join(Tag, Tag.id == TagImplication.antecedent_id)
        .where(Tag.owner_id == current_user.id)
        .options(
            selectinload(TagImplication.antecedent),
            selectinload(TagImplication.consequent),
        )
        .offset((page - 1) * limit)
        .limit(limit)
    )
    result = await db.execute(stmt)
    implications = list(result.scalars().all())
    return [i.to_dict() for i in implications]


@router.post("/tag-implications")
async def create_implication(
    request: CreateImplicationRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a tag implication between two of this user's own tags."""
    # Get source tag
    ant_result = await db.execute(
        select(Tag).where(Tag.name == request.antecedent.lower(), Tag.owner_id == current_user.id)
    )
    antecedent = ant_result.scalars().first()
    if not antecedent:
        raise HTTPException(status_code=404, detail=f"Tag not found: {request.antecedent}")

    # Get target tag
    con_result = await db.execute(
        select(Tag).where(Tag.name == request.consequent.lower(), Tag.owner_id == current_user.id)
    )
    consequent = con_result.scalars().first()
    if not consequent:
        raise HTTPException(status_code=404, detail=f"Tag not found: {request.consequent}")

    # Check for existing implication
    existing = await db.execute(
        select(TagImplication).where(
            TagImplication.antecedent_id == antecedent.id,
            TagImplication.consequent_id == consequent.id,
        )
    )
    if existing.scalars().first():
        raise HTTPException(status_code=409, detail="Implication already exists")

    impl = TagImplication(antecedent_id=antecedent.id, consequent_id=consequent.id)
    db.add(impl)
    await db.commit()
    await db.refresh(impl, ["antecedent", "consequent"])

    return impl.to_dict()


@router.delete("/tag-implications/{impl_id}")
async def delete_implication(
    impl_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Delete a tag implication, if its antecedent tag belongs to this user."""
    result = await db.execute(
        select(TagImplication)
        .join(Tag, Tag.id == TagImplication.antecedent_id)
        .where(TagImplication.id == impl_id, Tag.owner_id == current_user.id)
    )
    impl = result.scalars().first()

    if not impl:
        raise HTTPException(status_code=404, detail="Implication not found")

    await db.delete(impl)
    await db.commit()
    return {"success": True}


# Tag Aliases
@router.get("/tag-aliases")
async def list_aliases(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List this user's own tag aliases."""
    stmt = (
        select(TagAlias)
        .options(selectinload(TagAlias.target))
        .where(TagAlias.owner_id == current_user.id)
        .offset((page - 1) * limit)
        .limit(limit)
    )
    result = await db.execute(stmt)
    aliases = list(result.scalars().all())
    return [a.to_dict() for a in aliases]


@router.post("/tag-aliases")
async def create_alias(
    request: CreateAliasRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Create a tag alias pointing at one of this user's own tags."""
    alias_name = request.alias.lower().replace(" ", "_")

    # Check if alias already exists
    existing = await db.execute(
        select(TagAlias).where(TagAlias.alias_name == alias_name, TagAlias.owner_id == current_user.id)
    )
    if existing.scalars().first():
        raise HTTPException(status_code=409, detail="Alias already exists")

    # Check if alias name is already a real tag
    existing_tag = await db.execute(
        select(Tag).where(Tag.name == alias_name, Tag.owner_id == current_user.id)
    )
    if existing_tag.scalars().first():
        raise HTTPException(status_code=409, detail="Alias name is already a tag")

    # Get target tag
    target_result = await db.execute(
        select(Tag).where(Tag.name == request.target.lower(), Tag.owner_id == current_user.id)
    )
    target = target_result.scalars().first()
    if not target:
        raise HTTPException(status_code=404, detail=f"Target tag not found: {request.target}")

    alias = TagAlias(owner_id=current_user.id, alias_name=alias_name, target_id=target.id)
    db.add(alias)
    await db.commit()
    await db.refresh(alias, ["target"])

    return alias.to_dict()


@router.delete("/tag-aliases/{alias_id}")
async def delete_alias(
    alias_id: int, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Delete a tag alias from this user's own library."""
    result = await db.execute(
        select(TagAlias).where(TagAlias.id == alias_id, TagAlias.owner_id == current_user.id)
    )
    alias = result.scalars().first()

    if not alias:
        raise HTTPException(status_code=404, detail="Alias not found")

    await db.delete(alias)
    await db.commit()
    return {"success": True}
