"""Lightweight exact-file searches against public booru APIs.

This is intentionally separate from visual reverse image search.  MD5 lookup is
cheap, deterministic, and does not upload media to a third-party service, but it
only succeeds when the remote board has the exact same file bytes.  Resized or
re-encoded copies still need the browser extension's visual-search stack.
"""
from __future__ import annotations

import asyncio
import hashlib
import time
import urllib.parse
from pathlib import Path

import httpx

from .booru_suggest import DANBOORU, GELBOORU, _get_json, gelbooru_credentials

USER_AGENT = "NekoBooru/1.0 (per-post exact lookup)"
DEFAULT_TIMEOUT = 6.0
CACHE_TTL_SECONDS = 900.0
CACHE_MAX_ENTRIES = 512

_cache: dict[str, tuple[float, dict]] = {}


def calculate_md5(file_path: Path) -> str:
    digest = hashlib.md5()  # noqa: S324 - compatibility identifier, not security
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _danbooru_match(row: dict) -> dict | None:
    try:
        post_id = int(row.get("id"))
    except (TypeError, ValueError):
        return None
    return {
        "provider": "danbooru",
        "providerLabel": "Danbooru",
        "id": post_id,
        "postUrl": f"{DANBOORU}/posts/{post_id}",
        "fileUrl": row.get("file_url") or row.get("large_file_url") or row.get("preview_file_url"),
        "source": row.get("source") or None,
        "width": row.get("image_width"),
        "height": row.get("image_height"),
        "rating": row.get("rating") or None,
        "md5": row.get("md5") or None,
    }


def _gelbooru_rows(payload) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    rows = payload.get("post")
    if isinstance(rows, dict):
        return [rows]
    return [row for row in (rows or []) if isinstance(row, dict)]


def _gelbooru_match(row: dict) -> dict | None:
    try:
        post_id = int(row.get("id"))
    except (TypeError, ValueError):
        return None
    return {
        "provider": "gelbooru",
        "providerLabel": "Gelbooru",
        "id": post_id,
        "postUrl": f"{GELBOORU}/index.php?page=post&s=view&id={post_id}",
        "fileUrl": row.get("file_url") or row.get("sample_url") or row.get("preview_url"),
        "source": row.get("source") or None,
        "width": row.get("width"),
        "height": row.get("height"),
        "rating": row.get("rating") or None,
        "md5": row.get("md5") or None,
    }


def parse_danbooru_matches(payload) -> list[dict]:
    rows = payload if isinstance(payload, list) else []
    return [match for row in rows if isinstance(row, dict) if (match := _danbooru_match(row))]


def parse_gelbooru_matches(payload) -> list[dict]:
    return [match for row in _gelbooru_rows(payload) if (match := _gelbooru_match(row))]


def _gelbooru_post_query(md5: str, limit: int) -> dict[str, str | int]:
    params: dict[str, str | int] = {
        "page": "dapi",
        "s": "post",
        "q": "index",
        "json": 1,
        "tags": f"md5:{md5}",
        "limit": limit,
    }
    credentials = gelbooru_credentials()
    if credentials:
        params["user_id"], params["api_key"] = credentials
    return params


async def find_exact_online_matches(
    file_path: Path,
    *,
    limit: int = 10,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict:
    """Return byte-exact Danbooru/Gelbooru matches for a stored post."""
    md5 = await asyncio.to_thread(calculate_md5, file_path)
    cached = _cache.get(md5)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    if cached:
        _cache.pop(md5, None)

    danbooru_url = f"{DANBOORU}/posts.json?" + urllib.parse.urlencode(
        {"tags": f"md5:{md5}", "limit": limit}
    )
    gelbooru_url = f"{GELBOORU}/index.php?" + urllib.parse.urlencode(
        _gelbooru_post_query(md5, limit)
    )

    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT},
        timeout=timeout,
        follow_redirects=True,
    ) as client:
        danbooru_payload, gelbooru_payload = await asyncio.gather(
            _get_json(client, danbooru_url, "danbooru"),
            _get_json(client, gelbooru_url, "gelbooru"),
        )

    danbooru_matches = parse_danbooru_matches(danbooru_payload)
    gelbooru_matches = parse_gelbooru_matches(gelbooru_payload)
    answer = {
        "md5": md5,
        "matches": [*danbooru_matches, *gelbooru_matches],
        "providers": [
            {
                "id": "danbooru",
                "label": "Danbooru",
                "available": danbooru_payload is not None,
                "count": len(danbooru_matches),
            },
            {
                "id": "gelbooru",
                "label": "Gelbooru",
                "available": gelbooru_payload is not None,
                "count": len(gelbooru_matches),
            },
        ],
    }
    # An answered miss is worth caching; a total network failure is not. This
    # makes repeated per-post checks cheap without hiding transient outages.
    if danbooru_payload is not None or gelbooru_payload is not None:
        if len(_cache) >= CACHE_MAX_ENTRIES:
            oldest = min(_cache, key=lambda key: _cache[key][0])
            _cache.pop(oldest, None)
        _cache[md5] = (time.monotonic() + CACHE_TTL_SECONDS, answer)
    return answer
