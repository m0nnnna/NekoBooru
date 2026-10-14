from __future__ import annotations

import math
from typing import Awaitable

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import get_current_user
from ..models import User
from ..services import booru_search
from ..services.auth import visible_owner_ids
from ..services.booru_access import booru_search_allowed, require_booru_search

router = APIRouter(prefix="/api/booru-search", tags=["booru-search"])

DEFAULT_RETRY_AFTER = 60


class InLibraryRequest(BaseModel):
    keys: list[str] = []


class GelbooruCategoriesRequest(BaseModel):
    tags: list[str] = []


def _coded(status: int, code: str, message: str, *, headers: dict | None = None, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra}, headers=headers)


async def _upstream(call: Awaitable[dict]) -> dict:
    # Never a 401 here: the frontend treats any 401 as a lost session.
    try:
        return await call
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise _coded(400, "gelbooru_credentials_missing", str(exc)) from exc
    except booru_search.UpstreamThrottled as exc:
        retry_after = DEFAULT_RETRY_AFTER if exc.retry_after is None else max(1, math.ceil(exc.retry_after))
        raise _coded(
            429,
            "upstream_throttled",
            str(exc),
            headers={"Retry-After": str(retry_after)},
            retryAfter=retry_after,
        ) from exc
    except RuntimeError as exc:
        raise _coded(502, "upstream_error", str(exc)) from exc


@router.get("/status")
async def get_status(current_user: User = Depends(get_current_user)):
    """What the home view may render; logged-in only, deliberately not gated."""
    return {
        "enabled": booru_search_allowed(current_user),
        "gelbooruConfigured": booru_search.gelbooru_configured(),
        "sources": list(booru_search.SOURCES),
    }


@router.get("/gelbooru")
async def search_gelbooru(
    tags: str = "",
    page: int = 1,
    limit: int = booru_search.DAPI_PAGE_SIZE,
    current_user: User = Depends(require_booru_search),
):
    """One Gelbooru results page, relayed raw (the API key never leaves the server)."""
    return await _upstream(booru_search.gelbooru_search_page(tags, page, limit))


@router.get("/safebooru")
async def search_safebooru(
    tags: str = "",
    page: int = 1,
    limit: int = booru_search.DAPI_PAGE_SIZE,
    current_user: User = Depends(require_booru_search),
):
    """One Safebooru results page, relayed raw (Safebooru sends no CORS header).

    ``total`` comes from Safebooru's XML count, cached per query; null when it fails.
    """
    return await _upstream(booru_search.safebooru_search_page(tags, page, limit))


@router.post("/in-library")
async def lookup_in_library(
    request: InLibraryRequest,
    current_user: User = Depends(require_booru_search),
    db: AsyncSession = Depends(get_db),
):
    """Which ``<site>:<id>`` keys already have a live post carrying the ``<site>_<id>`` tag."""
    owner_ids = await visible_owner_ids(db, current_user)
    try:
        return await booru_search.in_library_lookup(db, request.keys, owner_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/gelbooru-categories")
async def get_gelbooru_categories(
    request: GelbooruCategoriesRequest,
    current_user: User = Depends(require_booru_search),
):
    """Tag categories for queued Gelbooru imports, batched and cached server-side."""
    return await _upstream(booru_search.gelbooru_categories(request.tags))


@router.get("/gelbooru-media")
async def relay_gelbooru_media(
    url: str,
    byte_range: str | None = Header(default=None, alias="Range"),
    current_user: User = Depends(require_booru_search),
):
    """One Gelbooru thumbnail, sample or original, streamed with gelbooru.com as
    the referer (its CDN redirects any other); Range passes through for video."""
    try:
        target = booru_search.gelbooru_media_url(url)
    except ValueError as exc:
        raise _coded(400, "bad_media_url", str(exc)) from exc
    try:
        client, upstream = await booru_search.open_gelbooru_media(target, byte_range)
    except httpx.HTTPError as exc:
        raise _coded(502, "upstream_error", "Gelbooru media could not be fetched") from exc
    if upstream.status_code not in (200, 206):
        status = upstream.status_code
        await upstream.aclose()
        await client.aclose()
        if status == 429:
            raise _coded(429, "upstream_throttled", "Gelbooru is rate limiting", retryAfter=DEFAULT_RETRY_AFTER)
        raise _coded(404 if status == 404 else 502, "upstream_error", f"Gelbooru media answered HTTP {status}")

    headers = {name: upstream.headers[name] for name in booru_search.MEDIA_HEADERS if name in upstream.headers}
    headers["Cache-Control"] = "private, max-age=86400"

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(body(), status_code=upstream.status_code, headers=headers)
