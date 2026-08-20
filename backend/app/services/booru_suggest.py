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

Typing is a request amplifier - one tag can be a dozen keystrokes, and these are
other people's servers - so four things stand between the keyboard and an
upstream request, in the order they are checked:

1. the response cache, which also caches misses;
2. prefix suppression - a shorter prefix that found nothing means a longer term
   starting with it finds nothing either, since the boards only narrow as you
   type;
3. single-flight, so two clients typing the same word make one request;
4. a token bucket, which answers local-only rather than queueing once the burst
   is spent, plus a per-board cooldown that honours ``Retry-After`` when a board
   does push back.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import urllib.parse

import httpx

from ..config import settings
from .settings import SettingsManager
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

# Outbound budget, shared by every client of this instance. A burst covers
# finishing the word you are on; the refill rate is what a sustained typing
# session is allowed to cost. Overrunning it costs suggestions, never an error.
RATE_LIMIT_BURST = 8
RATE_LIMIT_PER_SECOND = 2.0
# Applied per board when it answers 429/503 without saying how long to wait.
DEFAULT_COOLDOWN_SECONDS = 60.0
MAX_COOLDOWN_SECONDS = 900.0

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
# Requests this process has already sent and is still waiting on, so N clients
# typing the same word cost one upstream request rather than N.
_inflight: dict[tuple[str, int], "asyncio.Future[list[dict]]"] = {}
# Board id -> monotonic deadline before which we will not call it again.
_cooldowns: dict[str, float] = {}


class _RequestBudget:
    """Token bucket over outbound suggestion requests.

    Deliberately not a queue: a keystroke's request is worthless by the time a
    queue would release it, so an exhausted bucket declines and the caller falls
    back to local suggestions.
    """

    def __init__(self, burst: int, per_second: float) -> None:
        self.capacity = float(burst)
        self.per_second = per_second
        self.tokens = float(burst)
        self.updated = time.monotonic()

    def take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.per_second)
        self.updated = now
        if self.tokens < 1.0:
            return False
        self.tokens -= 1.0
        return True

    def reset(self) -> None:
        self.tokens = self.capacity
        self.updated = time.monotonic()


_budget = _RequestBudget(RATE_LIMIT_BURST, RATE_LIMIT_PER_SECOND)


def gelbooru_credentials() -> tuple[str, str] | None:
    """Configured ``(user_id, api_key)`` without exposing either via settings JSON."""
    saved_user_id, saved_api_key = SettingsManager(settings.config_file).get_gelbooru_credentials()
    user_id = saved_user_id or os.environ.get("GELBOORU_USER_ID")
    api_key = saved_api_key or os.environ.get("GELBOORU_API_KEY")
    if not user_id or not api_key:
        return None
    return str(user_id).strip(), str(api_key).strip()


def save_gelbooru_credentials(user_id: str, api_key: str) -> None:
    user_id = str(user_id or "").strip()
    api_key = str(api_key or "").strip()
    if not user_id.isdigit() or int(user_id) <= 0:
        raise ValueError("Gelbooru user ID must be a positive number")
    if not api_key:
        raise ValueError("Gelbooru API key cannot be empty")
    SettingsManager(settings.config_file).set_gelbooru_credentials(user_id, api_key)
    clear_cache()


def delete_gelbooru_credentials() -> None:
    SettingsManager(settings.config_file).delete_gelbooru_credentials()
    clear_cache()


def _gelbooru_query(term: str, limit: int) -> dict[str, str | int]:
    """Autocomplete query parameters, including account auth when configured."""
    params: dict[str, str | int] = {
        "page": "autocomplete2",
        "term": term,
        "type": "tag_query",
        "limit": limit,
    }
    credentials = gelbooru_credentials()
    if credentials:
        params["user_id"], params["api_key"] = credentials
    return params


def _redact_url(url: str) -> str:
    """Hide credentials before a request URL reaches application logs."""
    try:
        parts = urllib.parse.urlsplit(str(url))
        query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        clean = [(key, "[redacted]" if key == "api_key" else value) for key, value in query]
        return urllib.parse.urlunsplit((*parts[:3], urllib.parse.urlencode(clean), parts.fragment))
    except Exception:  # noqa: BLE001 - logging must never break a request path
        return re.sub(r"([?&]api_key=)[^&\s]+", r"\1[redacted]", str(url))


class _HttpxCredentialFilter(logging.Filter):
    """Redact credential-bearing request URLs from httpx's INFO access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                _redact_url(str(arg)) if "api_key=" in str(arg) else arg
                for arg in record.args
            )
        return True


_httpx_logger = logging.getLogger("httpx")
if not any(isinstance(item, _HttpxCredentialFilter) for item in _httpx_logger.filters):
    _httpx_logger.addFilter(_HttpxCredentialFilter())


def _cooling_down(board: str) -> bool:
    until = _cooldowns.get(board)
    if until is None:
        return False
    if time.monotonic() >= until:
        _cooldowns.pop(board, None)
        return False
    return True


def _cool_down(board: str, seconds: float) -> None:
    seconds = max(1.0, min(float(seconds or DEFAULT_COOLDOWN_SECONDS), MAX_COOLDOWN_SECONDS))
    _cooldowns[board] = max(_cooldowns.get(board, 0.0), time.monotonic() + seconds)
    logger.warning("%s is rate limiting tag suggestions; backing off for %.0fs", board, seconds)


def _retry_after_seconds(response: httpx.Response) -> float:
    """Seconds from a Retry-After header. Only the delta form is worth honouring.

    The HTTP-date form exists but no booru sends it here, and guessing at clock
    skew to parse one would be a worse answer than the default cooldown.
    """
    raw = (response.headers.get("Retry-After") or "").strip()
    try:
        return float(raw)
    except (TypeError, ValueError):
        return DEFAULT_COOLDOWN_SECONDS


def _prefix_known_empty(term: str, limit: int) -> bool:
    """True when a cached shorter prefix of ``term`` found nothing upstream.

    Both boards match the typed text against the tag, so the result set can only
    shrink as the term grows: if "hoshin" had no matches, "hoshino" has none
    either, and the request can be skipped outright.
    """
    for length in range(MIN_QUERY_LENGTH, len(term)):
        cached = _cache_get((term[:length], limit))
        if cached is not None and not cached:
            return True
    return False


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
    """Forget everything this module remembers, including the rate-limit state."""
    _cache.clear()
    _cooldowns.clear()
    _budget.reset()


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


async def _get_json(client: httpx.AsyncClient, url: str, board: str):
    if _cooling_down(board):
        return None
    try:
        response = await client.get(url)
    except httpx.HTTPError as exc:
        logger.debug("tag suggestion request failed for %s: %s", _redact_url(url), exc)
        return None
    # 429 is the explicit answer and 503 the one an overloaded board gives
    # instead; both mean stop asking, not retry on the next keystroke.
    if response.status_code in (429, 503):
        _cool_down(board, _retry_after_seconds(response))
        return None
    if response.status_code >= 400:
        logger.debug(
            "tag suggestion request returned HTTP %s for %s",
            response.status_code,
            _redact_url(url),
        )
        return None
    try:
        return response.json()
    except ValueError:
        return None


async def suggest_tags(query: str, *, limit: int = 10, timeout: float = DEFAULT_TIMEOUT) -> list[dict]:
    """Remote tag suggestions for a partial name. Never raises.

    Answers from cache, from a shorter prefix that already came back empty, or
    from a request that has to get past the shared budget first - see the module
    docstring. An unavailable board and a spent budget look the same to the
    caller: an empty list, and local suggestions only.
    """
    term = normalize_tag(query)
    if len(term) < MIN_QUERY_LENGTH:
        return []
    key = (term, limit)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    if _prefix_known_empty(term, limit):
        return []

    pending = _inflight.get(key)
    if pending is not None:
        try:
            # shield() so this waiter's own cancellation cannot cancel the
            # request the other waiters are still on.
            return list(await asyncio.shield(pending))
        except Exception:  # noqa: BLE001 - the owner logs; a waiter just misses out
            return []

    if not _budget.take():
        logger.debug("tag suggestion budget spent, skipping upstream lookup for %s", term)
        return []

    future: asyncio.Future[list[dict]] = asyncio.get_running_loop().create_future()
    _inflight[key] = future
    answer: list[dict] | None = None
    try:
        answer = await _fetch_suggestions(term, limit=limit, timeout=timeout)
    finally:
        _inflight.pop(key, None)
        if not future.done():
            # Resolved even on failure, so a waiter never hangs on a dead request.
            future.set_result(answer or [])

    if answer is None:
        return []
    _cache_put(key, answer)
    return answer


async def _fetch_suggestions(term: str, *, limit: int, timeout: float) -> list[dict] | None:
    """The actual upstream calls, past every guard. Never raises.

    Danbooru answers first because its categories are the most reliable;
    Gelbooru only tops the list up when Danbooru came back short, so the common
    case costs one request rather than two.

    Returns ``None`` when no board actually answered, which the caller must not
    confuse with an answered "no matches": caching a timeout as an empty result
    would suppress the term for the whole TTL and every longer term with it.
    """
    collected: list[dict] = []
    seen: set[str] = set()
    answered = False

    def absorb(payload) -> list[dict]:
        nonlocal answered
        if payload is None:
            return []
        answered = True
        return payload

    def collect(rows: list[dict]) -> None:
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
            collect(parse_danbooru_suggestions(absorb(await _get_json(client, danbooru_url, "danbooru"))))

            if len(collected) < limit:
                gelbooru_url = f"{GELBOORU}/index.php?" + urllib.parse.urlencode(
                    _gelbooru_query(term, limit)
                )
                collect(
                    parse_gelbooru_suggestions(
                        absorb(await _get_json(client, gelbooru_url, "gelbooru"))
                    )
                )
    except (httpx.HTTPError, asyncio.TimeoutError) as exc:
        logger.debug("tag suggestions unavailable for %s: %s", term, exc)
        return None
    except Exception as exc:  # noqa: BLE001 - a typing aid must never break typing
        logger.debug("tag suggestions failed for %s: %s", term, exc)
        return None

    return collected if answered else None
