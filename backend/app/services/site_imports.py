"""Metadata needed by one-click imports from supported source sites."""
from __future__ import annotations

import html
import re
import time

import httpx

from .booru_suggest import gelbooru_credentials

GELBOORU = "https://gelbooru.com"
USER_AGENT = "NekoBooru/1.0 (Gelbooru original importer)"
DEFAULT_TIMEOUT = 10.0
TAG_TYPE_TO_CATEGORY = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
    6: "meta",
}


def _rows(payload, key: str) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    rows = payload.get(key)
    if isinstance(rows, dict):
        return [rows]
    return [row for row in (rows or []) if isinstance(row, dict)]


async def _fetch_json(params: dict[str, str | int], timeout: float):
    # booru_suggest installs an httpx logging filter that redacts api_key. Use
    # params separately as well, so credentials never become a string built or
    # logged by this service. httpx's CA bundle is also more reliable than the
    # host Python urllib trust chain on Windows.
    try:
        async with httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT},
            timeout=timeout,
            follow_redirects=True,
        ) as client:
            response = await client.get(f"{GELBOORU}/index.php", params=params)
    except httpx.HTTPError as exc:
        raise RuntimeError("Gelbooru could not be reached") from exc
    if response.status_code in {401, 403}:
        raise PermissionError("Gelbooru rejected the saved API credentials")
    if response.status_code >= 400:
        raise RuntimeError(f"Gelbooru returned HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError("Gelbooru returned an invalid response") from exc


def _auth_params() -> dict[str, str]:
    credentials = gelbooru_credentials()
    if not credentials:
        raise PermissionError("Gelbooru API credentials are not configured in NekoBooru Settings")
    user_id, api_key = credentials
    return {"user_id": user_id, "api_key": api_key}


def _safety(rating: str) -> str:
    value = str(rating or "").strip().lower()
    if value in {"e", "explicit"}:
        return "unsafe"
    if value in {"q", "questionable", "s", "sensitive"}:
        return "sketchy"
    return "safe"


async def gelbooru_post_for_import(post_id: int, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """Return the exact file URL and source-provided tags for one Gelbooru post."""
    if post_id <= 0:
        raise ValueError("Invalid Gelbooru post ID")
    auth = _auth_params()
    payload = await _fetch_json(
        {
            "page": "dapi",
            "s": "post",
            "q": "index",
            "json": 1,
            "id": post_id,
            **auth,
        },
        timeout,
    )
    posts = _rows(payload, "post")
    if not posts:
        raise LookupError("Gelbooru post was not found")
    post = posts[0]
    file_url = str(post.get("file_url") or "").strip()
    if not file_url.startswith(("http://", "https://")):
        raise LookupError("Gelbooru did not return an original file URL")

    tags = _post_tags(post)
    categories = await _tag_categories(tags, auth, timeout)
    return _import_payload(post, post_id, file_url, tags, categories)


def _decoded(value) -> str:
    # The Gelbooru engine's dapi HTML-escapes text fields (girls&#039;_frontline,
    # &gt;_&lt;); unescaping text that was never escaped leaves it as it is.
    return html.unescape(str(value or ""))


def _post_tags(post: dict) -> list[str]:
    return list(dict.fromkeys(_decoded(post.get("tags")).split()))


# Tag types change rarely, and a search page repeats most of its tags from
# post to post and page to page, so they are remembered for a day.
_TAG_CATEGORY_TTL = 24 * 60 * 60
_tag_category_cache: dict[str, tuple[float, str]] = {}


async def _tag_categories(tags: list[str], auth: dict[str, str], timeout: float) -> dict[str, str]:
    now = time.monotonic()
    categories = {tag: "general" for tag in tags}
    unknown = []
    for tag in categories:
        cached = _tag_category_cache.get(tag)
        if cached and now - cached[0] < _TAG_CATEGORY_TTL:
            categories[tag] = cached[1]
        else:
            unknown.append(tag)
    # Keep each request URL bounded; posts with hundreds of tags still receive
    # every tag even if category enrichment for a later chunk fails.
    for offset in range(0, len(unknown), 80):
        chunk = unknown[offset:offset + 80]
        try:
            tag_payload = await _fetch_json(
                {
                    "page": "dapi",
                    "s": "tag",
                    "q": "index",
                    "json": 1,
                    "limit": len(chunk),
                    "names": " ".join(chunk),
                    **auth,
                },
                timeout,
            )
        except RuntimeError:
            continue
        for row in _rows(tag_payload, "tag"):
            name = _decoded(row.get("name") or row.get("tag")).strip()
            category = TAG_TYPE_TO_CATEGORY.get(int(row.get("type") or 0))
            if name in categories and category:
                categories[name] = category
                _tag_category_cache[name] = (now, category)
    return categories


def _import_payload(post: dict, post_id: int, file_url: str, tags: list[str], categories: dict[str, str]) -> dict:
    tags = list(tags)
    categories = {tag: categories.get(tag, "general") for tag in tags}
    id_tag = f"gelbooru_{post_id}"
    if id_tag not in tags:
        tags.append(id_tag)
    categories[id_tag] = "meta"
    post_url = f"{GELBOORU}/index.php?page=post&s=view&id={post_id}"
    return {
        "kind": "gelbooru",
        "postId": post_id,
        "postUrl": post_url,
        "fileUrl": file_url,
        "referer": f"{GELBOORU}/",
        "tags": tags,
        "tagCategories": categories,
        "tagDisplayNames": {},
        "safety": _safety(post.get("rating")),
        "remoteSource": _decoded(post.get("source")).strip() or None,
        "width": post.get("width"),
        "height": post.get("height"),
    }


GELBOORU_SEARCH_PAGE_SIZE = 42
GELBOORU_SEARCH_MAX_POSTS = 100


async def gelbooru_search_for_import(
    tags: str,
    offset: int,
    ids: list[int],
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict:
    """Original files and tags for the posts one Gelbooru search page shows.

    The page's own query is replayed in one API call - the site's pid is a
    post offset, the API's a page number, at the site's 42 per page - and only
    the posts the reader saw (``ids``, in page order) are returned. One that
    call misses (the page shifted since it loaded) gets a lookup of its own.
    Tag types are fetched once for the whole page.
    """
    wanted = [post_id for post_id in dict.fromkeys(ids) if post_id > 0][:GELBOORU_SEARCH_MAX_POSTS]
    if not wanted:
        raise ValueError("No Gelbooru posts to import")
    auth = _auth_params()
    query = " ".join(str(tags or "").split())[:500]
    payload = await _fetch_json(
        {
            "page": "dapi",
            "s": "post",
            "q": "index",
            "json": 1,
            "tags": query,
            "limit": GELBOORU_SEARCH_PAGE_SIZE,
            "pid": max(0, offset) // GELBOORU_SEARCH_PAGE_SIZE,
            **auth,
        },
        timeout,
    )
    by_id: dict[int, dict] = {}
    for row in _rows(payload, "post"):
        try:
            by_id[int(row.get("id"))] = row
        except (TypeError, ValueError):
            continue
    for post_id in wanted:
        if post_id in by_id:
            continue
        try:
            rows = _rows(
                await _fetch_json(
                    {"page": "dapi", "s": "post", "q": "index", "json": 1, "id": post_id, **auth},
                    timeout,
                ),
                "post",
            )
        except RuntimeError:
            continue
        if rows:
            by_id[post_id] = rows[0]

    found: list[tuple[int, dict, str]] = []
    missing: list[dict] = []
    for post_id in wanted:
        post = by_id.get(post_id)
        file_url = str((post or {}).get("file_url") or "").strip()
        if not post:
            missing.append({"postId": post_id, "reason": "Gelbooru did not return this post"})
        elif not file_url.startswith(("http://", "https://")):
            missing.append({"postId": post_id, "reason": "Gelbooru did not return an original file URL"})
        else:
            found.append((post_id, post, file_url))

    all_tags = list(dict.fromkeys(tag for _, post, _ in found for tag in _post_tags(post)))
    categories = await _tag_categories(all_tags, auth, timeout)
    return {
        "tags": query,
        "posts": [
            _import_payload(post, post_id, file_url, _post_tags(post), categories)
            for post_id, post, file_url in found
        ],
        "missing": missing,
    }


# Sankaku spells a qualified character or series in full -
# honoka_(dead_or_alive) - where Danbooru, and Gelbooru/Safebooru after it,
# abbreviate it to honoka_(doa). Imports take Danbooru's spelling so one
# character is one tag whichever site it came from.
DANBOORU = "https://danbooru.donmai.us"
DANBOORU_USER_AGENT = "NekoBooru/1.0 (Sankaku tag names)"
DANBOORU_NAME_CACHE_SECONDS = 24 * 3600.0
MAX_NAME_LOOKUPS = 200
# Names per Danbooru request; every step below is batched, so a post's worth
# of tags - or a backfill's - costs a handful of requests, not several per tag.
NAME_BATCH = 80
_QUALIFIED_TAG = re.compile(r"^(?P<base>.+?)_\((?P<qualifier>[^()]+)\)$")
_danbooru_name_cache: dict[str, tuple[float, str | None]] = {}


def _initials(qualifier: str) -> str:
    words = [word for word in qualifier.split("_") if word]
    return "".join(word[0] for word in words) if len(words) >= 2 else ""


async def _danbooru_get(client: httpx.AsyncClient, path: str, params: dict[str, str | int]) -> list[dict]:
    response = await client.get(f"{DANBOORU}{path}", params=params)
    response.raise_for_status()
    payload = response.json()
    return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []


def _batches(names: list[str]):
    for offset in range(0, len(names), NAME_BATCH):
        yield names[offset:offset + NAME_BATCH]


async def _danbooru_used_names(client: httpx.AsyncClient, names: list[str]) -> set[str]:
    used: set[str] = set()
    for batch in _batches(names):
        rows = await _danbooru_get(
            client,
            "/tags.json",
            {"search[name_comma]": ",".join(batch), "only": "name,post_count", "limit": len(batch)},
        )
        used.update(str(row.get("name")) for row in rows if int(row.get("post_count") or 0) > 0)
    return used


async def _danbooru_aliases(client: httpx.AsyncClient, field: str, names: list[str]) -> list[tuple[str, str]]:
    """Active (antecedent, consequent) alias pairs whose ``field`` is one of ``names``."""
    pairs: list[tuple[str, str]] = []
    for batch in _batches(names):
        rows = await _danbooru_get(
            client,
            "/tag_aliases.json",
            {
                f"search[{field}_comma]": ",".join(batch),
                "search[status]": "active",
                "only": "antecedent_name,consequent_name",
                "limit": 1000,
            },
        )
        pairs.extend(
            (str(row["antecedent_name"]), str(row["consequent_name"]))
            for row in rows
            if row.get("antecedent_name") and row.get("consequent_name")
        )
    return pairs


async def _danbooru_spellings(client: httpx.AsyncClient, tags: list[str]) -> dict[str, str | None]:
    """Danbooru's name for each tag - itself when Danbooru uses it - or None."""
    used = await _danbooru_used_names(client, tags)
    result: dict[str, str | None] = {tag: tag for tag in tags if tag in used}
    missing = [tag for tag in tags if tag not in used]
    if not missing:
        return result

    # Danbooru may alias the whole name: special_week_(uma_musume) -> ..._(umamusume).
    for antecedent, consequent in await _danbooru_aliases(client, "antecedent_name", missing):
        if antecedent in missing and antecedent not in result:
            result[antecedent] = consequent
    rest = [tag for tag in missing if tag not in result]

    # Otherwise try the other name order (e621's yui_hirasawa is Danbooru's
    # hirasawa_yui), then swap the qualifier for one Danbooru treats as the
    # same series, in either direction (uma_musume -> umamusume,
    # dead_or_alive <- doa), or for its initials - keeping a candidate only
    # if Danbooru really uses it.
    from .e621_names import swapped_name

    qualifiers = sorted({match.group("qualifier") for tag in rest if (match := _QUALIFIED_TAG.match(tag))})
    variants: dict[str, list[str]] = {qualifier: [] for qualifier in qualifiers}
    if qualifiers:
        for antecedent, consequent in await _danbooru_aliases(client, "antecedent_name", qualifiers):
            if antecedent in variants:
                variants[antecedent].append(consequent)
        for antecedent, consequent in await _danbooru_aliases(client, "consequent_name", qualifiers):
            if consequent in variants:
                variants[consequent].append(antecedent)
    candidates: dict[str, list[str]] = {}
    for tag in rest:
        swapped = swapped_name(tag)
        candidates[tag] = [swapped] if swapped else []
        match = _QUALIFIED_TAG.match(tag)
        if not match:
            continue
        base, qualifier = match.group("base"), match.group("qualifier")
        options = variants.get(qualifier, []) + [_initials(qualifier)]
        candidates[tag] += [f"{base}_({option})" for option in dict.fromkeys(options) if option and option != qualifier]
    found = await _danbooru_used_names(client, sorted({name for names in candidates.values() for name in names}))
    for tag in rest:
        result[tag] = next((name for name in candidates.get(tag, []) if name in found), None)
    return result


async def danbooru_names(
    tags: list[str],
    categories: dict[str, str],
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, str]:
    """Map each character/copyright tag Danbooru spells differently to its spelling.

    Character tags are all checked (an unqualified one may be in the other
    name order); copyright tags only when qualified.

    Lookups that fail leave the tags as they are and are not cached, so an
    outage never renames anything and the next import tries again.
    """
    wanted = [
        tag
        for tag in dict.fromkeys(str(tag).strip().lower() for tag in tags)
        if tag
        and (
            categories.get(tag) == "character"
            or (categories.get(tag) == "copyright" and _QUALIFIED_TAG.match(tag))
        )
    ][:MAX_NAME_LOOKUPS]
    renames: dict[str, str] = {}
    if not wanted:
        return renames
    now = time.monotonic()
    uncached = [tag for tag in wanted if not (tag in _danbooru_name_cache and _danbooru_name_cache[tag][0] > now)]
    if uncached:
        async with httpx.AsyncClient(
            headers={"User-Agent": DANBOORU_USER_AGENT},
            timeout=timeout,
            follow_redirects=True,
        ) as client:
            try:
                spellings = await _danbooru_spellings(client, uncached)
            except (httpx.HTTPError, ValueError):
                spellings = {}
        for tag, name in spellings.items():
            _danbooru_name_cache[tag] = (now + DANBOORU_NAME_CACHE_SECONDS, name)
    for tag in wanted:
        cached = _danbooru_name_cache.get(tag)
        name = cached[1] if cached else None
        if name and name != tag:
            renames[tag] = name
    return renames


# The reverse direction, for tags that came from Danbooru, Gelbooru, or an
# older import: find the name Sankaku files honoka_(doa) under. Only a
# qualifier Danbooru expands (doa -> dead_or_alive, kancolle ->
# kantai_collection) can make Sankaku's name differ, so those expansions are
# fetched first in batches, and Sankaku is asked only about the few tags
# whose qualifier has one.
SANKAKU_API = "https://sankakuapi.com"
EXPANSION_BATCH = 50
_qualifier_expansions: dict[str, list[str]] = {}


class SourceThrottled(RuntimeError):
    """A site answered 429/403/503: stop asking it for now."""


def _raise_for_throttle(response: httpx.Response, site: str) -> None:
    if response.status_code in (403, 429, 503):
        raise SourceThrottled(f"{site} answered HTTP {response.status_code}")
    response.raise_for_status()


async def _sankaku_has_posts(client: httpx.AsyncClient, tag: str) -> bool:
    response = await client.get(f"{SANKAKU_API}/posts", params={"tags": tag, "limit": 1})
    _raise_for_throttle(response, "Sankaku")
    payload = response.json()
    return isinstance(payload, list) and bool(payload)


async def expand_qualifiers(client: httpx.AsyncClient, qualifiers) -> dict[str, list[str]]:
    """Danbooru's longer names for each qualifier, a batch of qualifiers per request."""
    wanted = [q for q in dict.fromkeys(qualifiers) if q and q not in _qualifier_expansions]
    for offset in range(0, len(wanted), EXPANSION_BATCH):
        batch = wanted[offset:offset + EXPANSION_BATCH]
        response = await client.get(
            f"{DANBOORU}/tag_aliases.json",
            params={
                "search[antecedent_name_comma]": ",".join(batch),
                "search[status]": "active",
                "only": "antecedent_name,consequent_name",
                "limit": 1000,
            },
        )
        _raise_for_throttle(response, "Danbooru")
        payload = response.json()
        rows = [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []
        for qualifier in batch:
            _qualifier_expansions[qualifier] = []
        for row in rows:
            antecedent = str(row.get("antecedent_name") or "")
            consequent = str(row.get("consequent_name") or "")
            if antecedent in batch and consequent:
                _qualifier_expansions[antecedent].append(consequent)
    return {q: _qualifier_expansions.get(q, []) for q in qualifiers}


def sankaku_candidates(spelling: str, expansions: dict[str, list[str]]) -> list[str]:
    """Sankaku spellings worth checking for ``spelling``, from the expansions."""
    match = _QUALIFIED_TAG.match(spelling)
    if not match:
        return []
    base = match.group("base")
    return [f"{base}_({longer})" for longer in expansions.get(match.group("qualifier"), [])]


def qualifier_of(spelling: str) -> str:
    match = _QUALIFIED_TAG.match(spelling)
    return match.group("qualifier") if match else ""


async def sankaku_name_for(client: httpx.AsyncClient, spelling: str) -> str | None:
    """Sankaku's name for a qualified tag it spells differently, or None.

    Network errors propagate so a caller can tell "no" from "could not ask".
    """
    qualifier = qualifier_of(spelling)
    if not qualifier:
        return None
    expansions = await expand_qualifiers(client, [qualifier])
    for candidate in sankaku_candidates(spelling, expansions):
        if await _sankaku_has_posts(client, candidate):
            return candidate
    return None


async def lookup_sankaku_name(spelling: str, *, timeout: float = DEFAULT_TIMEOUT) -> str | None:
    """sankaku_name_for() with its own client, for a single on-demand lookup."""
    async with httpx.AsyncClient(
        headers={"User-Agent": DANBOORU_USER_AGENT},
        timeout=timeout,
        follow_redirects=True,
    ) as client:
        return await sankaku_name_for(client, spelling)
