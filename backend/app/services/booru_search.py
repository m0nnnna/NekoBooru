"""Server-side half of the aggregated booru search.

Danbooru, e621 and Sankaku are searched straight from the browser. Gelbooru
and Safebooru send no CORS header (and Gelbooru's API key must stay on the
server), so their result pages are relayed here - as the raw rows the site
returned; the frontend adapters do all normalisation. The in-library lookup
and the Gelbooru tag categories used by the import queue live here too.
"""
from __future__ import annotations

import math
import re
import time
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Post, Tag
from ..models.post import PostTag
from . import site_imports
from .booru_suggest import gelbooru_credentials
from .tagging import normalize_tag

DEFAULT_TIMEOUT = 10.0
USER_AGENT = "NekoBooru/1.0 (booru search relay)"
SOURCES = ("danbooru", "e621", "sankaku", "gelbooru", "safebooru")
UPSTREAMS = {
    "gelbooru": ("Gelbooru", "https://gelbooru.com/index.php"),
    "safebooru": ("Safebooru", "https://safebooru.org/index.php"),
}

# Gelbooru's CDN redirects every referer but gelbooru.com to hotlink.php, and
# a page cannot choose its own Referer, so the browser shows Gelbooru media
# through this relay. Only Gelbooru's own media hosts and paths, https only.
GELBOORU_MEDIA_HOST = re.compile(r"^(?:img\d*|video-cdn\d*)\.gelbooru\.com$")
GELBOORU_MEDIA_PATHS = ("/thumbnails/", "/samples/", "/images/")
GELBOORU_REFERER = "https://gelbooru.com/"
MEDIA_TIMEOUT = 30.0
MEDIA_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified")
_media_transport: httpx.AsyncBaseTransport | None = None  # tests swap in an httpx.MockTransport

MAX_QUERY_CHARS = 500
MAX_PAGE = 500
DAPI_PAGE_SIZE = 42  # Gelbooru's and Safebooru's own page size, the relays' default limit
MAX_LIMIT = 100
MAX_LOOKUP_KEYS = 500
LOOKUP_CHUNK = 200
MAX_CATEGORY_TAGS = 500

CREDENTIALS_MISSING = "Gelbooru needs an API user id and key saved in Settings → AI auto-tagging → Gelbooru"

# Sankaku ids are alphanumeric; every other site numbers its posts.
_NUMERIC_ID = re.compile(r"\d{1,20}")
_SANKAKU_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


class UpstreamThrottled(RuntimeError):
    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class UpstreamError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def gelbooru_configured() -> bool:
    return gelbooru_credentials() is not None


def _auth_params() -> dict[str, str]:
    credentials = gelbooru_credentials()
    if not credentials:
        raise PermissionError(CREDENTIALS_MISSING)
    user_id, api_key = credentials
    return {"user_id": user_id, "api_key": api_key}


def _retry_after(value: str | None) -> float | None:
    value = str(value or "").strip()
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
    if math.isnan(seconds) or math.isinf(seconds):
        return None
    return max(0.0, seconds)


async def _request(params: dict[str, str | int], timeout: float, site: str) -> httpx.Response:
    # Credentials travel only inside httpx params - never formatted into a URL
    # string by this service - and booru_suggest's httpx log filter redacts
    # api_key from the request line httpx logs.
    label, url = UPSTREAMS[site]
    try:
        async with httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT},
            timeout=timeout,
            follow_redirects=True,
        ) as client:
            response = await client.get(url, params=params)
    except httpx.HTTPError as exc:
        raise UpstreamError(f"{label} could not be reached") from exc
    status = response.status_code
    if site == "gelbooru" and status in {401, 403}:
        raise PermissionError("Gelbooru rejected the saved API credentials")
    if status in {429, 503}:
        raise UpstreamThrottled(
            f"{label} is rate limiting requests (HTTP {status})",
            _retry_after(response.headers.get("retry-after")),
        )
    if status >= 400:
        raise UpstreamError(f"{label} returned HTTP {status}", status)
    return response


async def _fetch_json(params: dict[str, str | int], timeout: float, *, site: str = "gelbooru"):
    response = await _request(params, timeout, site)
    if not response.content.strip():
        return None
    try:
        return response.json()
    except ValueError as exc:
        status = response.status_code
        raise UpstreamError(f"{UPSTREAMS[site][0]} returned an invalid response (HTTP {status})", status) from exc


def _clean_query(tags: str) -> str:
    query = " ".join(str(tags or "").split())
    if len(query) > MAX_QUERY_CHARS:
        raise ValueError(f"Search query is longer than {MAX_QUERY_CHARS} characters")
    return query


def _check_paging(page: int, limit: int) -> None:
    if not 1 <= int(page) <= MAX_PAGE:
        raise ValueError(f"Page must be between 1 and {MAX_PAGE}")
    if not 1 <= int(limit) <= MAX_LIMIT:
        raise ValueError(f"Limit must be between 1 and {MAX_LIMIT}")


def _dapi_params(tags: str, page: int, limit: int) -> dict[str, str | int]:
    _check_paging(page, limit)
    return {
        "page": "dapi",
        "s": "post",
        "q": "index",
        "json": 1,
        "tags": _clean_query(tags),
        "limit": int(limit),
        "pid": int(page) - 1,
    }


def _gelbooru_total(payload) -> int | None:
    attributes = payload.get("@attributes") if isinstance(payload, dict) else None
    if not isinstance(attributes, dict):
        return None
    try:
        return int(attributes.get("count"))
    except (TypeError, ValueError):
        return None


async def gelbooru_search_page(tags: str, page: int, limit: int, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    params = _dapi_params(tags, page, limit)
    payload = await _fetch_json({**params, **_auth_params()}, timeout, site="gelbooru")
    return {
        "site": "gelbooru",
        "page": int(page),
        "limit": int(limit),
        "total": _gelbooru_total(payload),
        "posts": site_imports._rows(payload, "post"),
    }


# Safebooru's JSON carries no count, but its XML answer does: one limit=0
# request per tag string, remembered for a while so paging never repeats it.
SAFEBOORU_COUNT_TTL = 10 * 60
MAX_COUNT_CACHE = 256
_POSTS_COUNT = re.compile(rb"<posts\b[^>]*?\bcount=[\"'](\d{1,12})[\"']")
_safebooru_count_cache: dict[str, tuple[float, int]] = {}


async def _safebooru_total(query: str, timeout: float) -> int | None:
    now = time.monotonic()
    cached = _safebooru_count_cache.get(query)
    if cached and now - cached[0] < SAFEBOORU_COUNT_TTL:
        return cached[1]
    params = {"page": "dapi", "s": "post", "q": "index", "tags": query, "limit": 0}
    try:
        response = await _request(params, timeout, "safebooru")
    except RuntimeError:
        return None  # a missing count never fails the search
    match = _POSTS_COUNT.search(response.content or b"")
    if not match:
        return None
    if len(_safebooru_count_cache) >= MAX_COUNT_CACHE:
        for key, (stamp, _) in list(_safebooru_count_cache.items()):
            if now - stamp >= SAFEBOORU_COUNT_TTL:
                del _safebooru_count_cache[key]
        if len(_safebooru_count_cache) >= MAX_COUNT_CACHE:
            _safebooru_count_cache.clear()
    total = int(match.group(1))
    _safebooru_count_cache[query] = (now, total)
    return total


async def safebooru_search_page(tags: str, page: int, limit: int, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    params = _dapi_params(tags, page, limit)
    payload = await _fetch_json(params, timeout, site="safebooru")
    posts = [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []
    # Asked only after the page succeeded, so a throttled site gets no extra request.
    total = await _safebooru_total(str(params["tags"]), timeout)
    return {"site": "safebooru", "page": int(page), "limit": int(limit), "total": total, "posts": posts}


def parse_key(key: str) -> tuple[str, str] | None:
    site, sep, post_id = str(key or "").strip().partition(":")
    site = site.lower()
    if not sep or site not in SOURCES:
        return None
    pattern = _SANKAKU_ID if site == "sankaku" else _NUMERIC_ID
    if not pattern.fullmatch(post_id):
        return None
    return site, post_id


def _id_tag(site: str, post_id: str) -> str:
    return normalize_tag(f"{site}_{post_id}")


async def in_library_lookup(
    db: AsyncSession,
    keys: list[str],
    owner_ids: list[int],
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict:
    if not keys:
        raise ValueError("No keys to look up")
    if len(keys) > MAX_LOOKUP_KEYS:
        raise ValueError(f"At most {MAX_LOOKUP_KEYS} keys can be looked up at once")
    keys_by_tag: dict[str, list[str]] = {}
    for key in keys:
        parsed = parse_key(key)
        if parsed:
            keys_by_tag.setdefault(_id_tag(*parsed), []).append(key)
    found: dict[str, dict] = {}
    names = list(keys_by_tag)
    for offset in range(0, len(names), LOOKUP_CHUNK):
        chunk = names[offset:offset + LOOKUP_CHUNK]
        result = await db.execute(
            select(Tag.name, func.min(Post.id))
            .join(PostTag, PostTag.c.tag_id == Tag.id)
            .join(Post, Post.id == PostTag.c.post_id)
            .where(
                Tag.name.in_(chunk),
                Tag.owner_id.in_(owner_ids),
                Post.owner_id.in_(owner_ids),
                Post.deleted_at.is_(None),
            )
            .group_by(Tag.name)
        )
        for name, post_id in result.all():
            for key in keys_by_tag.get(name, []):
                found[key] = {"postId": int(post_id)}
    return {"found": found}


async def gelbooru_categories(tags: list[str], *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    names = list(dict.fromkeys(str(tag or "").strip() for tag in tags or []))
    names = [name for name in names if name]
    if not names:
        raise ValueError("No tags to categorise")
    if len(names) > MAX_CATEGORY_TAGS:
        raise ValueError(f"At most {MAX_CATEGORY_TAGS} tags can be categorised at once")
    categories = await site_imports._tag_categories(names, _auth_params(), timeout)
    return {"categories": categories}


def gelbooru_media_url(url: str) -> str:
    """The URL itself when it is Gelbooru media, else ValueError."""
    parsed = urlsplit(str(url or "").strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not GELBOORU_MEDIA_HOST.match(host) or parsed.port or parsed.username:
        raise ValueError("Only Gelbooru media URLs can be relayed")
    segments = parsed.path.split("/")
    if (
        not parsed.path.startswith(GELBOORU_MEDIA_PATHS)
        or any(segment in {".", ".."} for segment in segments)
        or "%2e" in parsed.path.lower()
        or "\\" in parsed.path
    ):
        raise ValueError("Only Gelbooru media URLs can be relayed")
    return urlunsplit(("https", host, parsed.path, parsed.query, ""))


async def open_gelbooru_media(url: str, byte_range: str | None) -> tuple[httpx.AsyncClient, httpx.Response]:
    """A streamed GET of Gelbooru media with its referer; the caller closes both."""
    client = httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT, "Referer": GELBOORU_REFERER},
        timeout=MEDIA_TIMEOUT,
        follow_redirects=False,
        transport=_media_transport,
    )
    request = client.build_request("GET", url, headers={"Range": byte_range} if byte_range else None)
    try:
        return client, await client.send(request, stream=True)
    except BaseException:
        await client.aclose()
        raise
