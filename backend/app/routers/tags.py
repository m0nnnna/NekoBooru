from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..models import Tag, TagCategory, TagImplication, TagAlias

router = APIRouter(prefix="/api", tags=["tags"])


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
    db: AsyncSession = Depends(get_db),
):
    """List tags with search and pagination."""
    stmt = select(Tag).options(selectinload(Tag.category))

    # Apply search filter
    if q:
        stmt = stmt.where(Tag.name.ilike(f"%{q}%"))

    # Get total count
    count_stmt = select(func.count(Tag.id))
    if q:
        count_stmt = count_stmt.where(Tag.name.ilike(f"%{q}%"))
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
    db: AsyncSession = Depends(get_db),
):
    """Get tag suggestions for autocomplete."""
    stmt = (
        select(Tag)
        .options(selectinload(Tag.category))
        .where(Tag.name.ilike(f"{q}%"))
        .order_by(Tag.usage_count.desc())
        .limit(limit)
    )

    result = await db.execute(stmt)
    tags = list(result.scalars().all())

    return [t.to_dict() for t in tags]


@router.get("/tags/{tag_name}")
async def get_tag(tag_name: str, db: AsyncSession = Depends(get_db)):
    """Get a single tag by name."""
    result = await db.execute(
        select(Tag)
        .options(
            selectinload(Tag.category),
            selectinload(Tag.implications_from).selectinload(TagImplication.consequent),
            selectinload(Tag.implications_to).selectinload(TagImplication.antecedent),
            selectinload(Tag.aliases),
        )
        .where(Tag.name == tag_name)
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
async def create_tag(request: CreateTagRequest, db: AsyncSession = Depends(get_db)):
    """Create a new tag."""
    # Check if tag already exists
    existing = await db.execute(select(Tag).where(Tag.name == request.name.lower()))
    if existing.scalars().first():
        raise HTTPException(status_code=409, detail="Tag already exists")

    # Get category
    cat_result = await db.execute(select(TagCategory).where(TagCategory.name == request.category))
    category = cat_result.scalars().first()

    if not category:
        raise HTTPException(status_code=400, detail=f"Unknown category: {request.category}")

    tag = Tag(name=request.name.lower().replace(" ", "_"), category_id=category.id)
    db.add(tag)
    await db.commit()
    await db.refresh(tag, ["category"])

    return tag.to_dict()


@router.put("/tags/{tag_name}")
async def update_tag(tag_name: str, request: UpdateTagRequest, db: AsyncSession = Depends(get_db)):
    """Update a tag."""
    result = await db.execute(
        select(Tag).options(selectinload(Tag.category)).where(Tag.name == tag_name)
    )
    tag = result.scalars().first()

    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    if request.name is not None:
        # Check for conflicts
        new_name = request.name.lower().replace(" ", "_")
        if new_name != tag.name:
            existing = await db.execute(select(Tag).where(Tag.name == new_name))
            if existing.scalars().first():
                raise HTTPException(status_code=409, detail="Tag name already taken")
            tag.name = new_name

    if request.category is not None:
        cat_result = await db.execute(select(TagCategory).where(TagCategory.name == request.category))
        category = cat_result.scalars().first()
        if not category:
            raise HTTPException(status_code=400, detail=f"Unknown category: {request.category}")
        tag.category_id = category.id

    await db.commit()
    await db.refresh(tag, ["category"])
    return tag.to_dict()


@router.delete("/tags/{tag_name}")
async def delete_tag(tag_name: str, db: AsyncSession = Depends(get_db)):
    """Delete a tag."""
    result = await db.execute(select(Tag).where(Tag.name == tag_name))
    tag = result.scalars().first()

    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    await db.delete(tag)
    await db.commit()
    return {"success": True}


# Tag Categories
@router.get("/tag-categories")
async def list_categories(db: AsyncSession = Depends(get_db)):
    """List all tag categories."""
    result = await db.execute(select(TagCategory).order_by(TagCategory.order))
    categories = list(result.scalars().all())
    return [c.to_dict() for c in categories]


# Tag Implications
@router.get("/tag-implications")
async def list_implications(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """List all tag implications."""
    stmt = (
        select(TagImplication)
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
async def create_implication(request: CreateImplicationRequest, db: AsyncSession = Depends(get_db)):
    """Create a tag implication."""
    # Get source tag
    ant_result = await db.execute(select(Tag).where(Tag.name == request.antecedent.lower()))
    antecedent = ant_result.scalars().first()
    if not antecedent:
        raise HTTPException(status_code=404, detail=f"Tag not found: {request.antecedent}")

    # Get target tag
    con_result = await db.execute(select(Tag).where(Tag.name == request.consequent.lower()))
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
async def delete_implication(impl_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a tag implication."""
    result = await db.execute(select(TagImplication).where(TagImplication.id == impl_id))
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
    db: AsyncSession = Depends(get_db),
):
    """List all tag aliases."""
    stmt = (
        select(TagAlias)
        .options(selectinload(TagAlias.target))
        .offset((page - 1) * limit)
        .limit(limit)
    )
    result = await db.execute(stmt)
    aliases = list(result.scalars().all())
    return [a.to_dict() for a in aliases]


@router.post("/tag-aliases")
async def create_alias(request: CreateAliasRequest, db: AsyncSession = Depends(get_db)):
    """Create a tag alias."""
    alias_name = request.alias.lower().replace(" ", "_")

    # Check if alias already exists
    existing = await db.execute(select(TagAlias).where(TagAlias.alias_name == alias_name))
    if existing.scalars().first():
        raise HTTPException(status_code=409, detail="Alias already exists")

    # Check if alias name is already a real tag
    existing_tag = await db.execute(select(Tag).where(Tag.name == alias_name))
    if existing_tag.scalars().first():
        raise HTTPException(status_code=409, detail="Alias name is already a tag")

    # Get target tag
    target_result = await db.execute(select(Tag).where(Tag.name == request.target.lower()))
    target = target_result.scalars().first()
    if not target:
        raise HTTPException(status_code=404, detail=f"Target tag not found: {request.target}")

    alias = TagAlias(alias_name=alias_name, target_id=target.id)
    db.add(alias)
    await db.commit()
    await db.refresh(alias, ["target"])

    return alias.to_dict()


@router.delete("/tag-aliases/{alias_id}")
async def delete_alias(alias_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a tag alias."""
    result = await db.execute(select(TagAlias).where(TagAlias.id == alias_id))
    alias = result.scalars().first()

    if not alias:
        raise HTTPException(status_code=404, detail="Alias not found")

    await db.delete(alias)
    await db.commit()
    return {"success": True}
