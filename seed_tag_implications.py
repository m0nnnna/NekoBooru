#!/usr/bin/env python
"""Seed character -> copyright tag implications from booru metadata.

CL Tagger's character head is far stronger than its copyright head: on a sample
image it identified ``c.c.`` at 57% while the correct ``code_geass`` scored
44.9% and fell below the threshold, beaten by an unrelated copyright at 68.9%.
A character's series is a fact rather than a prediction, so the reliable signal
can supply what the weak one misses.

NekoBooru already expands tag implications on every write (see
``services/tagging.py``), so an implication ``c.c. -> code_geass`` fixes this
for every future post without touching thresholds or adding noise.

Sources, tried in order per character:

  * Danbooru ``related_tag`` - purpose-built, one request, and it returns a
    ``frequency`` (the fraction of the character's posts carrying that
    copyright). ``c.c.`` -> ``code_geass`` comes back at 0.9992.
  * Safebooru - Gelbooru-family, no credentials needed. Its posts expose a flat
    tag string, so tags are classified with a second request.
  * Gelbooru - only when credentials are supplied; its API returns 401 without
    them.

Run with the project venv. Dry run by default; nothing is written until
``--apply``:

    venv\\Scripts\\python.exe seed_tag_implications.py
    venv\\Scripts\\python.exe seed_tag_implications.py --apply

Ambiguous characters are skipped rather than guessed: a missing copyright is a
small annoyance, a confidently wrong one is worse and you would never spot it.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

import httpx

USER_AGENT = "NekoBooru-implication-seeder/1.0"
DANBOORU = "https://danbooru.donmai.us"
SAFEBOORU = "https://safebooru.org"
GELBOORU = "https://gelbooru.com"
# Gelbooru/Safebooru tag types.
TAG_TYPE_COPYRIGHT = 3


def db_path_from_config() -> Path:
    """Resolve the live database path from the backend settings."""
    sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))
    from app.config import settings  # type: ignore

    return Path(settings.database_path)


def fetch(url: str, *, timeout: int = 30) -> httpx.Response:
    """GET a URL. httpx rather than urllib: urllib uses a system CA store that
    rejects Danbooru's certificate on this platform."""
    try:
        response = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise RuntimeError(str(exc)) from exc
    if response.status_code >= 400:
        raise RuntimeError(f"HTTP {response.status_code}")
    return response


def fetch_json(url: str, *, timeout: int = 30):
    response = fetch(url, timeout=timeout)
    if not response.text.strip():
        return None
    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError(f"non-JSON response ({response.text[:40]!r})") from exc


def fetch_tag_types(url: str) -> dict[str, int]:
    """Tag name -> numeric type, tolerating JSON or XML.

    Safebooru ignores ``json=1`` on its tag endpoint and answers in XML, so both
    shapes have to be handled.
    """
    response = fetch(url)
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


def apostrophe_variants(tag: str):
    """``lana_s_mother_pokemon`` was ``lana's_mother_(pokemon)`` upstream.

    normalize_tag() turns the apostrophe into an underscore, so put it back
    wherever a lone ``s`` sits between two words.
    """
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

    normalize_tag() turns Danbooru's ``shimakaze_(kancolle)`` into
    ``shimakaze_kancolle``, so the stored name no longer matches upstream.

    Single-bracket forms come first because they are overwhelmingly the common
    case, then two-bracket variants like ``aris_(maid)_(blue_archive)``. Order
    matters: every candidate costs a request, and the caller stops paying once
    one matches.
    """
    parts = tag.split("_")
    for index in range(1, len(parts)):
        yield "_".join(parts[:index]) + "_(" + "_".join(parts[index:]) + ")"
    # Costume/form variants carry two qualifier groups.
    for first in range(1, len(parts) - 1):
        for second in range(first + 1, len(parts)):
            yield (
                "_".join(parts[:first])
                + "_(" + "_".join(parts[first:second]) + ")"
                + "_(" + "_".join(parts[second:]) + ")"
            )


def candidate_names(tag: str):
    """Every upstream spelling worth trying for a flattened tag."""
    seen = {tag}
    for candidate in paren_variants(tag):
        if candidate not in seen:
            seen.add(candidate)
            yield candidate
    for base in apostrophe_variants(tag):
        for candidate in (base, *paren_variants(base)):
            if candidate not in seen:
                seen.add(candidate)
                yield candidate


def _danbooru_related_copyright(tag: str) -> tuple[str, float, int] | None:
    url = f"{DANBOORU}/related_tag.json?" + urllib.parse.urlencode(
        {"query": tag, "category": "copyright", "limit": 5}
    )
    data = fetch_json(url) or {}
    post_count = int(data.get("post_count") or 0)
    best = None
    for entry in data.get("related_tags") or []:
        name = ((entry.get("tag") or {}).get("name") or "").strip()
        # frequency = share of the character's posts that carry this copyright.
        score = float(entry.get("frequency") or entry.get("overlap_coefficient") or 0.0)
        if name and (best is None or score > best[1]):
            best = (name, score)
    if not best:
        return None
    return best[0], best[1], post_count


def danbooru_copyright(tag: str) -> tuple[str, float] | None:
    """Best copyright for a character via Danbooru's related_tag endpoint."""
    found = _danbooru_related_copyright(tag)
    if found and found[2] > 0:
        return found[0], found[1]

    # Unknown name: it is probably a flattened name_(series) tag. Try each
    # reconstruction and keep whichever matches the most posts upstream.
    best = None
    for candidate in candidate_names(tag):
        try:
            attempt = _danbooru_related_copyright(candidate)
        except RuntimeError:
            continue
        if attempt and attempt[2] > 0 and (best is None or attempt[2] > best[2]):
            best = attempt
    if best:
        return best[0], best[1]
    return (found[0], found[1]) if found else None


def _gelbooru_family_copyright(base: str, tag: str, credentials: str = "") -> tuple[str, float] | None:
    """Modal copyright from a Gelbooru-style index (Safebooru, Gelbooru)."""
    posts_url = f"{base}/index.php?" + urllib.parse.urlencode(
        {"page": "dapi", "s": "post", "q": "index", "json": "1", "limit": 20, "tags": tag}
    ) + credentials
    payload = fetch_json(posts_url)
    posts = payload.get("post", []) if isinstance(payload, dict) else (payload or [])
    if not posts:
        return None

    # These indexes return one flat tag string with no categories, so the tags
    # have to be classified in a second request.
    counts = Counter()
    for post in posts:
        for name in str(post.get("tags") or "").split():
            counts[name] += 1
    if not counts:
        return None

    candidates = [name for name, _ in counts.most_common(40)]
    tags_url = f"{base}/index.php?" + urllib.parse.urlencode(
        {"page": "dapi", "s": "tag", "q": "index", "json": "1", "names": " ".join(candidates)}
    ) + credentials
    types = fetch_tag_types(tags_url)
    copyrights = {name for name, kind in types.items() if kind == TAG_TYPE_COPYRIGHT}
    ranked = [(name, counts[name] / len(posts)) for name in candidates if name in copyrights]
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[1], reverse=True)
    return ranked[0]


def resolve_copyright(tag: str, *, gelbooru_credentials: str) -> tuple[str, float, str] | None:
    """Try each source in turn; returns (copyright, confidence, source)."""
    for source, resolver in (
        ("danbooru", lambda: danbooru_copyright(tag)),
        ("safebooru", lambda: _gelbooru_family_copyright(SAFEBOORU, tag)),
        *(
            (("gelbooru", lambda: _gelbooru_family_copyright(GELBOORU, tag, gelbooru_credentials)),)
            if gelbooru_credentials
            else ()
        ),
    ):
        try:
            found = resolver()
        except Exception as exc:  # noqa: BLE001 - one flaky source must not end the run
            print(f"    {source}: {exc}", file=sys.stderr)
            continue
        if found and found[0]:
            return found[0], found[1], source
    return None


def character_tags(con: sqlite3.Connection) -> list[tuple[int, str]]:
    rows = con.execute(
        """
        SELECT t.id, t.name FROM tags t
        JOIN tag_categories c ON c.id = t.category_id
        WHERE c.name = 'character'
        ORDER BY t.usage_count DESC, t.name
        """
    ).fetchall()
    return [(int(r[0]), str(r[1])) for r in rows]


def existing_implications(con: sqlite3.Connection) -> set[int]:
    return {int(r[0]) for r in con.execute("SELECT antecedent_id FROM tag_implications").fetchall()}


def tag_id_for(con: sqlite3.Connection, name: str) -> int | None:
    row = con.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
    return int(row[0]) if row else None


def copyright_category_id(con: sqlite3.Connection) -> int | None:
    row = con.execute("SELECT id FROM tag_categories WHERE name = 'copyright'").fetchone()
    return int(row[0]) if row else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write the implications (default is a dry run)")
    parser.add_argument("--min-confidence", type=float, default=0.8,
                        help="minimum share of the character's posts carrying the copyright (default 0.8)")
    parser.add_argument("--limit", type=int, default=0, help="only process the first N character tags")
    parser.add_argument("--delay", type=float, default=0.5, help="seconds between requests (default 0.5)")
    parser.add_argument("--gelbooru-api-key", default="", help="Gelbooru api_key (its API returns 401 without one)")
    parser.add_argument("--gelbooru-user-id", default="", help="Gelbooru user_id")
    args = parser.parse_args()

    credentials = ""
    if args.gelbooru_api_key and args.gelbooru_user_id:
        credentials = "&" + urllib.parse.urlencode(
            {"api_key": args.gelbooru_api_key, "user_id": args.gelbooru_user_id}
        )

    db = db_path_from_config()
    if not db.exists():
        print(f"Database not found: {db}", file=sys.stderr)
        return 1
    con = sqlite3.connect(str(db), timeout=30)
    try:
        characters = character_tags(con)
        if args.limit:
            characters = characters[: args.limit]
        already = existing_implications(con)
        copyright_id = copyright_category_id(con)

        print(f"Database   : {db}")
        print(f"Characters : {len(characters)}")
        print(f"Mode       : {'APPLY' if args.apply else 'dry run (nothing will be written)'}")
        print(f"Confidence : >= {args.min_confidence:.0%}\n")

        accepted: list[tuple[str, str, float, str]] = []
        skipped: list[tuple[str, str]] = []

        for index, (tag_id, name) in enumerate(characters, start=1):
            if tag_id in already:
                skipped.append((name, "already has an implication"))
                continue
            print(f"[{index}/{len(characters)}] {name}")
            found = resolve_copyright(name, gelbooru_credentials=credentials)
            if not found:
                skipped.append((name, "no copyright found"))
            else:
                copyright_name, confidence, source = found
                if confidence < args.min_confidence:
                    skipped.append((name, f"{copyright_name} only {confidence:.0%} ({source})"))
                else:
                    accepted.append((name, copyright_name, confidence, source))
                    print(f"    -> {copyright_name}  {confidence:.1%}  ({source})")
            time.sleep(max(0.0, args.delay))

        print(f"\n{'=' * 62}")
        print(f"Proposed implications: {len(accepted)}   skipped: {len(skipped)}")
        print("=" * 62)
        for name, copyright_name, confidence, source in accepted:
            print(f"  {name:38} -> {copyright_name:30} {confidence:6.1%}  {source}")
        if skipped:
            print("\nSkipped:")
            for name, reason in skipped[:40]:
                print(f"  {name:38}    {reason}")
            if len(skipped) > 40:
                print(f"  ... and {len(skipped) - 40} more")

        if not args.apply:
            print("\nDry run - nothing written. Re-run with --apply to insert these.")
            return 0

        written = 0
        for name, copyright_name, _confidence, _source in accepted:
            antecedent = tag_id_for(con, name)
            consequent = tag_id_for(con, copyright_name)
            if consequent is None:
                # The copyright is not in the library yet; create it so the
                # implication has something to point at, categorised properly.
                cur = con.execute(
                    "INSERT INTO tags (name, category_id, usage_count) VALUES (?, ?, 0)",
                    (copyright_name, copyright_id),
                )
                consequent = int(cur.lastrowid)
            if antecedent is None or consequent is None or antecedent == consequent:
                continue
            exists = con.execute(
                "SELECT 1 FROM tag_implications WHERE antecedent_id = ? AND consequent_id = ?",
                (antecedent, consequent),
            ).fetchone()
            if exists:
                continue
            con.execute(
                "INSERT INTO tag_implications (antecedent_id, consequent_id) VALUES (?, ?)",
                (antecedent, consequent),
            )
            written += 1
        con.commit()
        print(f"\nWrote {written} implications.")
        print("They apply to future tag writes; re-tag existing posts to backfill.")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())
