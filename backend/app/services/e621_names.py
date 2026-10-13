from __future__ import annotations

import re

import httpx

# Booru tag spellings across sites that order personal names differently.
# Danbooru writes family name first (hirasawa_yui), e621 given name first
# (yui_hirasawa); either may carry a series qualifier (_(k-on!)).

E621 = "https://e621.net"
# e621 rejects requests without an identifying User-Agent and asks clients
# not to pose as a browser.
E621_USER_AGENT = "NekoBooru/1.0 (e621 tag names)"
DEFAULT_TIMEOUT = 10.0

_TWO_PART_NAME = re.compile(r"^(?P<first>[^_()]+)_(?P<second>[^_()]+)(?P<qualifier>_\([^()]+\))?$")
_QUALIFIED = re.compile(r"^(?P<base>.+?)_\((?P<qualifier>[^()]+)\)$")


def swapped_name(spelling: str) -> str | None:
    """The other name order of a two-part name, keeping any qualifier; None otherwise."""
    match = _TWO_PART_NAME.match(spelling)
    if not match:
        return None
    return f"{match.group('second')}_{match.group('first')}{match.group('qualifier') or ''}"


def e621_candidates(spelling: str, alias: str | None, expansions: dict[str, list[str]]) -> list[str]:
    """Names e621 might file ``spelling`` under, the spelling itself first.

    e621's own alias, the swapped name order, and Danbooru's longer forms of
    the qualifier (doa -> dead_or_alive) on both orders.
    """
    swapped = swapped_name(spelling)
    names = [spelling, alias, swapped]
    for name in (spelling, swapped):
        match = _QUALIFIED.match(name or "")
        if match:
            names += [f"{match.group('base')}_({longer})" for longer in expansions.get(match.group("qualifier"), [])]
    return [name for name in dict.fromkeys(names) if name]


async def _e621_rows(client: httpx.AsyncClient, path: str, params: dict[str, str | int]) -> list[dict]:
    from .site_imports import _raise_for_throttle

    response = await client.get(f"{E621}{path}", params=params)
    _raise_for_throttle(response, "e621")
    payload = response.json()
    # An empty answer is {"tags": []} / {"tag_aliases": []} rather than [].
    return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []


async def _e621_alias(client: httpx.AsyncClient, spelling: str) -> str | None:
    rows = await _e621_rows(
        client,
        "/tag_aliases.json",
        {"search[antecedent_name]": spelling, "search[status]": "active", "limit": 5},
    )
    return next(
        (str(row["consequent_name"]) for row in rows if row.get("antecedent_name") == spelling and row.get("consequent_name")),
        None,
    )


async def _e621_post_counts(client: httpx.AsyncClient, names: list[str]) -> dict[str, int]:
    rows = await _e621_rows(client, "/tags.json", {"search[name]": ",".join(names), "limit": len(names)})
    return {str(row.get("name")): int(row.get("post_count") or 0) for row in rows if row.get("name") in names}


async def e621_name_for(client: httpx.AsyncClient, spelling: str) -> str | None:
    """e621's name for ``spelling`` when it differs, or None.

    Every candidate e621 has posts for competes; the highest post_count wins,
    earlier candidates winning ties. None when the spelling itself wins or
    nothing does. Network errors and SourceThrottled propagate so a caller
    can tell "no" from "could not ask".
    """
    from .site_imports import expand_qualifiers, qualifier_of

    alias = await _e621_alias(client, spelling)
    qualifier = qualifier_of(spelling)
    expansions = await expand_qualifiers(client, [qualifier]) if qualifier else {}
    candidates = e621_candidates(spelling, alias, expansions)
    counts = await _e621_post_counts(client, candidates)
    best, best_count = None, 0
    for name in candidates:
        if counts.get(name, 0) > best_count:
            best, best_count = name, counts[name]
    return best if best and best != spelling else None


async def lookup_e621_name(spelling: str, *, timeout: float = DEFAULT_TIMEOUT) -> str | None:
    """e621_name_for() with its own client, for a single on-demand lookup."""
    async with httpx.AsyncClient(
        headers={"User-Agent": E621_USER_AGENT},
        timeout=timeout,
        follow_redirects=True,
    ) as client:
        return await e621_name_for(client, spelling)
