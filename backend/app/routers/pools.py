from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..models import Pool, PoolPost, Post

router = APIRouter(prefix="/api/pools", tags=["pools"])


class CreatePoolRequest(BaseModel):
    name: str
    description: Optional[str] = None


class UpdatePoolRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class AddPostsRequest(BaseModel):
    postIds: list[int]


class ReorderRequest(BaseModel):
    postIds: list[int]  # New order of post IDs


@router.get("")
async def list_pools(
    q: str = Query("", description="Search query"),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """List pools with search and pagination."""
    stmt = select(Pool).options(selectinload(Pool.posts))

    # Apply search filter
    if q:
        stmt = stmt.where(Pool.name.ilike(f"%{q}%"))

    # Get total count
    count_stmt = select(func.count(Pool.id))
    if q:
        count_stmt = count_stmt.where(Pool.name.ilike(f"%{q}%"))
    total_result = await db.execute(count_stmt)
    total = total_result.scalar() or 0

    # Apply ordering and pagination
    stmt = stmt.order_by(Pool.updated_at.desc()).offset((page - 1) * limit).limit(limit)

    result = await db.execute(stmt)
    pools = list(result.scalars().all())

    return {
        "results": [p.to_dict() for p in pools],
        "total": total,
        "page": page,
        "limit": limit,
    }


@router.get("/{pool_id}")
async def get_pool(pool_id: int, db: AsyncSession = Depends(get_db)):
    """Get a single pool with its posts."""
    result = await db.execute(
        select(Pool)
        .options(selectinload(Pool.posts).selectinload(PoolPost.post).selectinload(Post.tags))
        .where(Pool.id == pool_id)
    )
    pool = result.scalars().first()

    if not pool:
        raise HTTPException(status_code=404, detail="Pool not found")

    data = pool.to_dict()
    data["posts"] = [
        pp.post.to_dict() for pp in sorted(pool.posts, key=lambda x: x.order) if pp.post
    ]
    return data


@router.post("")
async def create_pool(request: CreatePoolRequest, db: AsyncSession = Depends(get_db)):
    """Create a new pool."""
    pool = Pool(name=request.name, description=request.description)
    db.add(pool)
    await db.flush()  # Get pool ID
    await db.commit()
    
    # Reload with relationships for response (avoids lazy loading issues)
    result = await db.execute(
        select(Pool)
        .options(selectinload(Pool.posts))
        .where(Pool.id == pool.id)
    )
    pool = result.scalars().first()
    return pool.to_dict()


@router.put("/{pool_id}")
async def update_pool(pool_id: int, request: UpdatePoolRequest, db: AsyncSession = Depends(get_db)):
    """Update a pool."""
    result = await db.execute(select(Pool).where(Pool.id == pool_id))
    pool = result.scalars().first()

    if not pool:
        raise HTTPException(status_code=404, detail="Pool not found")

    if request.name is not None:
        pool.name = request.name
    if request.description is not None:
        pool.description = request.description

    await db.commit()
    
    # Reload with relationships for response (avoids lazy loading issues)
    result = await db.execute(
        select(Pool)
        .options(selectinload(Pool.posts))
        .where(Pool.id == pool_id)
    )
    pool = result.scalars().first()
    return pool.to_dict()


@router.delete("/{pool_id}")
async def delete_pool(pool_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a pool."""
    result = await db.execute(select(Pool).where(Pool.id == pool_id))
    pool = result.scalars().first()

    if not pool:
        raise HTTPException(status_code=404, detail="Pool not found")

    await db.delete(pool)
    await db.commit()
    return {"success": True}


@router.post("/{pool_id}/posts")
async def add_posts_to_pool(pool_id: int, request: AddPostsRequest, db: AsyncSession = Depends(get_db)):
    """Add posts to a pool."""
    result = await db.execute(
        select(Pool).options(selectinload(Pool.posts)).where(Pool.id == pool_id)
    )
    pool = result.scalars().first()

    if not pool:
        raise HTTPException(status_code=404, detail="Pool not found")

    # Get current max order
    max_order = max((pp.order for pp in pool.posts), default=-1)

    # Add new posts
    existing_post_ids = {pp.post_id for pp in pool.posts}
    for post_id in request.postIds:
        if post_id not in existing_post_ids:
            # Verify post exists
            post_result = await db.execute(select(Post).where(Post.id == post_id))
            if post_result.scalars().first():
                max_order += 1
                pool_post = PoolPost(pool_id=pool_id, post_id=post_id, order=max_order)
                db.add(pool_post)

    await db.commit()
    return {"success": True}


@router.delete("/{pool_id}/posts/{post_id}")
async def remove_post_from_pool(pool_id: int, post_id: int, db: AsyncSession = Depends(get_db)):
    """Remove a post from a pool."""
    result = await db.execute(
        select(PoolPost).where(PoolPost.pool_id == pool_id, PoolPost.post_id == post_id)
    )
    pool_post = result.scalars().first()

    if not pool_post:
        raise HTTPException(status_code=404, detail="Post not in pool")

    await db.delete(pool_post)
    await db.commit()
    return {"success": True}


@router.put("/{pool_id}/reorder")
async def reorder_pool(pool_id: int, request: ReorderRequest, db: AsyncSession = Depends(get_db)):
    """Reorder posts in a pool."""
    result = await db.execute(
        select(Pool).options(selectinload(Pool.posts)).where(Pool.id == pool_id)
    )
    pool = result.scalars().first()

    if not pool:
        raise HTTPException(status_code=404, detail="Pool not found")

    # Create mapping of post_id to PoolPost
    pool_posts = {pp.post_id: pp for pp in pool.posts}

    # Update order based on request
    for i, post_id in enumerate(request.postIds):
        if post_id in pool_posts:
            pool_posts[post_id].order = i

    await db.commit()
    return {"success": True}
