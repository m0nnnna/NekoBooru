"""Perceptual hashing for near-duplicate detection and "find similar".

Uses a 64-bit difference hash (dHash) computed with Pillow only — no numpy/
scipy dependency — stored as a 16-char hex string on each post. dHash is
robust to rescaling and re-encoding, so resized/re-compressed copies of the
same image land on identical or near-identical hashes. Similarity is the
Hamming distance between two hashes (0 = identical, larger = more different).
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Post, Tag

logger = logging.getLogger(__name__)

HASH_SIZE = 8  # 8x8 adjacent-pixel comparisons -> 64 bits
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def compute_dhash(path: Path) -> str | None:
    """Return the dHash of an image file as a 16-char hex string, or None."""
    try:
        with Image.open(path) as img:
            small = img.convert("L").resize(
                (HASH_SIZE + 1, HASH_SIZE), Image.Resampling.LANCZOS
            )
            px = list(small.getdata())
            row_w = HASH_SIZE + 1
            bits = 0
            for row in range(HASH_SIZE):
                for col in range(HASH_SIZE):
                    left = px[row * row_w + col]
                    right = px[row * row_w + col + 1]
                    bits = (bits << 1) | (1 if left > right else 0)
            return f"{bits:016x}"
    except Exception as exc:  # noqa: BLE001 - hashing is best-effort
        logger.debug("dhash failed for %s: %s", path, exc)
        return None


def phash_for_media(content_path: Path, thumb_path: Path | None, extension: str) -> str | None:
    """Hash the original for images/gifs; for videos hash the generated thumb."""
    ext = (extension or "").lower()
    target = content_path if ext in IMAGE_EXTS else thumb_path
    if target and Path(target).exists():
        return compute_dhash(Path(target))
    return None


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


async def find_similar(
    session: AsyncSession,
    post_id: int,
    limit: int = 24,
    max_distance: int = 12,
) -> list[dict]:
    """Posts most visually similar to ``post_id`` (excluding it), nearest first.

    Each result is ``{"post": <dict>, "distance": <int>}``. Comparison is a
    linear scan over stored hashes — fine for a personal library.
    """
    target = (
        await session.execute(select(Post.phash).where(Post.id == post_id))
    ).scalar()
    if not target:
        return []
    target_int = int(target, 16)

    rows = (
        await session.execute(
            select(Post.id, Post.phash).where(
                Post.phash.is_not(None),
                Post.deleted_at.is_(None),
                Post.id != post_id,
            )
        )
    ).all()

    scored = []
    for pid, ph in rows:
        try:
            dist = bin(target_int ^ int(ph, 16)).count("1")
        except (TypeError, ValueError):
            continue
        if dist <= max_distance:
            scored.append((pid, dist))
    scored.sort(key=lambda x: x[1])
    scored = scored[:limit]
    if not scored:
        return []

    from sqlalchemy.orm import selectinload

    ids = [pid for pid, _ in scored]
    posts = (
        await session.execute(
            select(Post)
            .options(selectinload(Post.tags).selectinload(Tag.category), selectinload(Post.favorites))
            .where(Post.id.in_(ids))
        )
    ).scalars().all()
    by_id = {p.id: p for p in posts}
    return [
        {"post": by_id[pid].to_dict(), "distance": dist}
        for pid, dist in scored
        if pid in by_id
    ]


# --- One-time backfill of hashes for posts uploaded before this feature -------

_backfill: dict | None = None


def backfill_status() -> dict | None:
    return dict(_backfill) if _backfill else None


async def count_missing(session: AsyncSession) -> int:
    from sqlalchemy import func

    return (
        await session.execute(
            select(func.count(Post.id)).where(
                Post.phash.is_(None), Post.deleted_at.is_(None)
            )
        )
    ).scalar() or 0


def start_backfill() -> dict:
    """Kick off a background pass that hashes every post missing a phash."""
    global _backfill
    if _backfill and _backfill.get("status") == "running":
        return dict(_backfill)
    _backfill = {"status": "running", "processed": 0, "updated": 0, "total": 0, "error": None}
    asyncio.create_task(_run_backfill())
    return dict(_backfill)


async def _run_backfill() -> None:
    from ..config import settings
    from ..database import async_session

    global _backfill
    try:
        async with async_session() as session:
            _backfill["total"] = await count_missing(session)

        while True:
            async with async_session() as session:
                batch = (
                    await session.execute(
                        select(Post).where(
                            Post.phash.is_(None), Post.deleted_at.is_(None)
                        ).limit(50)
                    )
                ).scalars().all()
                if not batch:
                    break
                for post in batch:
                    content = settings.posts_dir / post.content_path
                    thumb = settings.thumbs_dir / post.thumb_path
                    ph = await asyncio.to_thread(
                        phash_for_media, content, thumb, post.extension
                    )
                    _backfill["processed"] += 1
                    if ph:
                        post.phash = ph
                        _backfill["updated"] += 1
                    else:
                        # Mark unhashable rows so the loop terminates instead of
                        # re-selecting them forever.
                        post.phash = ""
                await session.commit()
        _backfill["status"] = "completed"
    except Exception as exc:  # noqa: BLE001
        logger.warning("phash backfill failed: %s", exc)
        if _backfill is not None:
            _backfill.update(status="failed", error=str(exc))
