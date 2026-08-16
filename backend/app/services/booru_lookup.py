"""Look up a character's copyright (series) from public booru metadata.

CL Tagger's character head is far stronger than its copyright head: on a sample
image it found ``c.c.`` at 57% while the correct ``code_geass`` scored 44.9% and
fell below the threshold, beaten to the cutoff by an unrelated copyright at
68.9%. No threshold fixes that - the next candidate down was junk 1.2 points
behind - but a character's series is a fact rather than a prediction, so the
reliable head can supply what the weak one misses.

Used two ways:

* ``seed_tag_implications.py`` writes the mapping into tag implications ahead of
  time, for offline expansion on every tag write.
* Auto-tagging can call :func:`copyrights_for_characters` live, which also
  covers characters no implication was ever seeded for.

Everything here is best-effort and additive. A slow or unreachable booru must
never fail or delay tagging, so failures are swallowed and results are cached
for the life of the process.
"""
from __future__ import annotations

import logging
import threading
import urllib.parse
import xml.etree.ElementTree as ET
from collections import Counter

import httpx

logger = logging.getLogger(__name__)

USER_AGENT = "NekoBooru/1.0 (tag metadata lookup)"
DANBOORU = "https://danbooru.donmai.us"
SAFEBOORU = "https://safebooru.org"
TAG_TYPE_COPYRIGHT = 3
DEFAULT_TIMEOUT = 6.0
# Share of a character's posts that must carry a copyright before it is trusted.
# A missing copyright is a small annoyance; a confidently wrong one is worse and
# would never be noticed.
DEFAULT_MIN_CONFIDENCE = 0.8
# Bound the work a single media item can trigger.
MAX_LOOKUPS_PER_ITEM = 8

_cache: dict[str, str | None] = {}
_cache_lock = threading.Lock()


def _get(url: str, timeout: float) -> httpx.Response | None:
    try:
        response = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout, follow_redirects=True)
    except httpx.HTTPError as exc:
        logger.debug("booru lookup failed for %s: %s", url, exc)
        return None
    if response.status_code >= 400:
        logger.debug("booru lookup returned HTTP %s for %s", response.status_code, url)
        return None
    return response


def apostrophe_variants(tag: str):
    """``lana_s_mother_pokemon`` was ``lana's_mother_(pokemon)`` upstream."""
    parts = tag.split("_")
    for index, part in enumerate(parts):
        if index == 0 or part != "s":
            continue
        rebuilt = list(parts)
        rebuilt[index - 1] = rebuilt[index - 1] + "'s"
        del rebuilt[index]
        yield "_".join(rebuilt)


def paren_variants(tag: str):
    """Rebuild the ``name_(series)`` forms that normalize_tag() flattened.

    Single-bracket forms first because they are overwhelmingly the common case,
    then two-bracket costume variants like ``aris_(maid)_(blue_archive)``. Order
    matters: each candidate costs a request and the caller stops on a match.
    """
    parts = tag.split("_")
    for index in range(1, len(parts)):
        yield "_".join(parts[:index]) + "_(" + "_".join(parts[index:]) + ")"
    for first in range(1, len(parts) - 1):
        for second in range(first + 1, len(parts)):
            yield (
                "_".join(parts[:first])
                + "_(" + "_".join(parts[first:second]) + ")"
                + "_(" + "_".join(parts[second:]) + ")"
            )


def candidate_names(tag: str, display_name: str | None = None):
    """Upstream spellings worth trying for a locally stored tag name.

    When the tagger recorded its own spelling ("miyu (blue archive)") the
    upstream name is a plain space-to-underscore swap, so try that first and
    skip the guesswork entirely.
    """
    seen: set[str] = set()

    def offer(value: str):
        if value and value not in seen:
            seen.add(value)
            return True
        return False

    if display_name:
        exact = display_name.strip().lower().replace(" ", "_")
        if offer(exact):
            yield exact
    if offer(tag):
        yield tag
    for candidate in paren_variants(tag):
        if offer(candidate):
            yield candidate
    for base in apostrophe_variants(tag):
        for candidate in (base, *paren_variants(base)):
            if offer(candidate):
                yield candidate


def _danbooru_related(tag: str, timeout: float) -> tuple[str, float, int] | None:
    url = f"{DANBOORU}/related_tag.json?" + urllib.parse.urlencode(
        {"query": tag, "category": "copyright", "limit": 5}
    )
    response = _get(url, timeout)
    if response is None:
        return None
    try:
        data = response.json() or {}
    except ValueError:
        return None
    post_count = int(data.get("post_count") or 0)
    best = None
    for entry in data.get("related_tags") or []:
        name = ((entry.get("tag") or {}).get("name") or "").strip()
        score = float(entry.get("frequency") or entry.get("overlap_coefficient") or 0.0)
        if name and (best is None or score > best[1]):
            best = (name, score)
    if not best:
        return None
    return best[0], best[1], post_count


def _safebooru_modal_copyright(tag: str, timeout: float) -> tuple[str, float] | None:
    posts_url = f"{SAFEBOORU}/index.php?" + urllib.parse.urlencode(
        {"page": "dapi", "s": "post", "q": "index", "json": "1", "limit": 20, "tags": tag}
    )
    response = _get(posts_url, timeout)
    if response is None:
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    posts = payload.get("post", []) if isinstance(payload, dict) else (payload or [])
    if not posts:
        return None

    counts: Counter = Counter()
    for post in posts:
        for name in str(post.get("tags") or "").split():
            counts[name] += 1
    if not counts:
        return None

    candidates = [name for name, _ in counts.most_common(40)]
    tags_url = f"{SAFEBOORU}/index.php?" + urllib.parse.urlencode(
        {"page": "dapi", "s": "tag", "q": "index", "json": "1", "names": " ".join(candidates)}
    )
    response = _get(tags_url, timeout)
    if response is None:
        return None
    types = _parse_tag_types(response)
    copyrights = {name for name, kind in types.items() if kind == TAG_TYPE_COPYRIGHT}
    ranked = [(name, counts[name] / len(posts)) for name in candidates if name in copyrights]
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[1], reverse=True)
    return ranked[0]


def _parse_tag_types(response: httpx.Response) -> dict[str, int]:
    """Safebooru ignores ``json=1`` on its tag endpoint and answers in XML."""
    body = response.text.strip()
    if not body:
        return {}
    if body.startswith("<"):
        try:
            root = ET.fromstring(body)
        except ET.ParseError:
            return {}
        return {
            str(node.get("name") or ""): int(node.get("type") or 0)
            for node in root.iter("tag")
            if node.get("name")
        }
    try:
        payload = response.json()
    except ValueError:
        return {}
    rows = payload.get("tag", []) if isinstance(payload, dict) else (payload or [])
    return {
        str(row.get("name") or row.get("tag") or ""): int(row.get("type") or 0)
        for row in rows
        if row.get("name") or row.get("tag")
    }


def copyright_for_character(
    tag: str,
    *,
    display_name: str | None = None,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    timeout: float = DEFAULT_TIMEOUT,
    use_cache: bool = True,
) -> str | None:
    """Best-effort copyright for one character tag, or None when unsure."""
    if not tag:
        return None
    if use_cache:
        with _cache_lock:
            if tag in _cache:
                return _cache[tag]

    found: str | None = None
    best_count = 0
    for candidate in candidate_names(tag, display_name):
        attempt = _danbooru_related(candidate, timeout)
        if attempt and attempt[2] > 0 and attempt[2] > best_count:
            if attempt[1] >= min_confidence:
                found, best_count = attempt[0], attempt[2]
            else:
                # The name exists upstream but its series is ambiguous; stop
                # rather than trying reconstructions that would match worse.
                best_count = attempt[2]
            break

    if not found:
        fallback = _safebooru_modal_copyright(tag, timeout)
        if fallback and fallback[1] >= min_confidence:
            found = fallback[0]

    if use_cache:
        with _cache_lock:
            _cache[tag] = found
    return found


def copyrights_for_characters(
    characters: list[str],
    *,
    display_names: dict[str, str] | None = None,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    timeout: float = DEFAULT_TIMEOUT,
    limit: int = MAX_LOOKUPS_PER_ITEM,
) -> dict[str, str]:
    """Map character tags to their copyright, skipping anything uncertain."""
    display_names = display_names or {}
    found: dict[str, str] = {}
    for tag in list(characters or [])[:limit]:
        try:
            copyright_name = copyright_for_character(
                tag,
                display_name=display_names.get(tag),
                min_confidence=min_confidence,
                timeout=timeout,
            )
        except Exception as exc:  # noqa: BLE001 - enrichment must never break tagging
            logger.debug("booru lookup failed for %s: %s", tag, exc)
            continue
        if copyright_name:
            found[tag] = copyright_name
    return found


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
