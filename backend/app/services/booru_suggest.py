"""Tag autocomplete from public boorus, for tags this library does not have yet.

Local autocomplete can only offer tags already in the database, which is
precisely wrong for the case that matters: typing a character or series for the
first time. The upstream boards have the correct spelling *and* the category, so
a remote suggestion arrives knowing it is a character rather than becoming one
more general tag to fix later.

Both endpoints used here answer without credentials, including Gelbooru's -
unlike its dapi, which is why :mod:`booru_lookup` cannot use it.

Best-effort throughout: a slow or unreachable board degrades to local-only
suggestions, never to an error or a stalled keystroke.
"""
from __future__ import annotations

import asyncio
import logging
import time
import urllib.parse

import httpx

from .tagging import normalize_tag

logger = logging.getLogger(__name__)

USER_AGENT = "NekoBooru/1.0 (tag autocomplete)"
DANBOORU = "https://danbooru.donmai.us"
GELBOORU = "https://gelbooru.com"
# Short: an autocomplete request the user is waiting on must not outlive the
# next keystroke by much.
DEFAULT_TIMEOUT = 2.5
CACHE_TTL_SECONDS = 900
CACHE_MAX_ENTRIES = 512
MIN_QUERY_LENGTH = 2

# Danbooru's numeric tag categories, shared by every board that copied its
# schema. 2 is deprecated upstream and 6+ have no local equivalent.
DANBOORU_CATEGORY_NAMES = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
}

# Gelbooru answers with words instead, and spells two of them differently.
GELBOORU_CATEGORY_NAMES = {
    "tag": "general",
    "general": "general",
    "artist": "artist",
    "copyright": "copyright",
    "character": "character",
    "metadata": "meta",
    "meta": "meta",
    "deprecated": None,
}

_cache: dict[tuple[str, int], tuple[float, list[dict]]] = {}


def _cache_get(key: tuple[str, int]) -> list[dict] | None:
    entry = _cache.get(key)
    if not entry:
        return None
    stored_at, value = entry
    if time.time() - stored_at > CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    return value


def _cache_put(key: tuple[str, int], value: list[dict]) -> None:
    if len(_cache) >= CACHE_MAX_ENTRIES:
        # Cheap eviction: this is a typing aid, not a hot path worth an LRU.
        oldest = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest, None)
    _cache[key] = (time.time(), value)


def clear_cache() -> None:
    _cache.clear()


def _suggestion(name: str, category: str | None, post_count, source: str) -> dict | None:
    tag = normalize_tag(name)
    if not tag or not category:
        return None
    try:
        count = int(post_count or 0)
    except (TypeError, ValueError):
        count = 0
    return {
        "name": tag,
        # The upstream spelling, so "miyu_(blue_archive)" still reads as
        # "miyu (blue archive)" after normalize_tag() flattens the name.
        "displayName": str(name).replace("_", " ").strip(),
        "category": category,
        # You have none of these locally - that is the whole point of the row -
        # so usageCount stays 0 and the board's own figure lives in its own
        # field. Putting it in usageCount would read as your post count.
        "usageCount": 0,
        "remoteCount": count,
        "remote": True,
        "source": source,
    }


def parse_danbooru_suggestions(payload) -> list[dict]:
    rows = payload if isinstance(payload, list) else []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        category = DANBOORU_CATEGORY_NAMES.get(row.get("category"))
        suggestion = _suggestion(row.get("value") or "", category, row.get("post_count"), "danbooru")
        if suggestion:
            out.append(suggestion)
    return out


def parse_gelbooru_suggestions(payload) -> list[dict]:
    rows = payload if isinstance(payload, list) else []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        category = GELBOORU_CATEGORY_NAMES.get(str(row.get("category") or "").lower())
        suggestion = _suggestion(row.get("value") or "", category, row.get("post_count"), "gelbooru")
        if suggestion:
            out.append(suggestion)
    return out


async def _get_json(client: httpx.AsyncClient, url: str):
    try:
        response = await client.get(url)
    except httpx.HTTPError as exc:
        logger.debug("tag suggestion request failed for %s: %s", url, exc)
        return None
    if response.status_code >= 400:
        logger.debug("tag suggestion request returned HTTP %s for %s", response.status_code, url)
        return None
    try:
        return response.json()
    except ValueError:
        return None


async def suggest_tags(query: str, *, limit: int = 10, timeout: float = DEFAULT_TIMEOUT) -> list[dict]:
    """Remote tag suggestions for a partial name. Never raises.

    Danbooru answers first because its categories are the most reliable;
    Gelbooru only tops the list up when Danbooru came back short, so the common
    case costs one request rather than two.
    """
    term = normalize_tag(query)
    if len(term) < MIN_QUERY_LENGTH:
        return []
    key = (term, limit)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    collected: list[dict] = []
    seen: set[str] = set()

    def absorb(rows: list[dict]) -> None:
        for row in rows:
            if row["name"] in seen or len(collected) >= limit:
                continue
            seen.add(row["name"])
            collected.append(row)

    try:
        async with httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, timeout=timeout, follow_redirects=True
        ) as client:
            danbooru_url = f"{DANBOORU}/autocomplete.json?" + urllib.parse.urlencode(
                {"search[query]": term, "search[type]": "tag_query", "limit": limit}
            )
            absorb(parse_danbooru_suggestions(await _get_json(client, danbooru_url)))

            if len(collected) < limit:
                gelbooru_url = f"{GELBOORU}/index.php?" + urllib.parse.urlencode(
                    {"page": "autocomplete2", "term": term, "type": "tag_query", "limit": limit}
                )
                absorb(parse_gelbooru_suggestions(await _get_json(client, gelbooru_url)))
    except (httpx.HTTPError, asyncio.TimeoutError) as exc:
        logger.debug("tag suggestions unavailable for %s: %s", term, exc)
        return []
    except Exception as exc:  # noqa: BLE001 - a typing aid must never break typing
        logger.debug("tag suggestions failed for %s: %s", term, exc)
        return []

    _cache_put(key, collected)
    return collected
