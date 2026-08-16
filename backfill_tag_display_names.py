#!/usr/bin/env python
"""Restore the parentheses on qualified tags that were stored before they were kept.

NekoBooru flattens ``nami_(one_piece)`` to ``nami_one_piece`` so both spellings
find each other in search, and stores the readable form separately as the tag's
``display_name``. Tags written before the taggers reported that spelling have no
display name at all, so the sidebar falls back to underscores-to-spaces and
shows "nami one piece".

The parentheses cannot be recovered from the flattened name alone -
``one_piece_swimsuit`` is not ``one_piece_(swimsuit)`` - so this reads the
qualified spellings straight out of the tagger vocabularies already downloaded
under the models directory. No network, no guessing: a tag is only rewritten
when its flattened name matches a vocabulary entry exactly.

Run with the project venv. Dry run by default; nothing is written until
``--apply``:

    venv\\Scripts\\python.exe backfill_tag_display_names.py
    venv\\Scripts\\python.exe backfill_tag_display_names.py --apply

Tags that already have a display name are left alone - a spelling the user or
the source booru supplied outranks anything reconstructed here.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))


def vocabulary_names() -> dict[str, list[str]]:
    """Every qualified tag spelling the downloaded model vocabularies know.

    Keyed by the flattened name, so a lookup is the same normalization the
    database rows went through, and valued by the readable display form rather
    than the raw entry - CL writes ``ryuujou (kancolle)`` where WD writes
    ``ryuujou_(kancolle)``, and those are the same spelling, not a disagreement.
    Models that are not downloaded are skipped; having none is a valid install,
    it just means there is nothing to backfill.
    """
    from app.services.auto_tagger import (  # type: ignore
        CL_VOCAB_FILE,
        _cached_file,
        _cached_tag_metadata_file,
        _read_cl_vocabulary,
        _read_tag_rows_from_csv,
        _read_tag_rows_from_json,
        model_cache_status,
        normalize_tag,
        qualified_display_name,
    )

    found: dict[str, list[str]] = {}

    def offer(raw: str) -> None:
        display = qualified_display_name(raw)
        if not display:
            return
        tag = normalize_tag(raw)
        if tag and display not in found.setdefault(tag, []):
            found[tag].append(display)

    def files_for(model_id: str) -> dict:
        try:
            return model_cache_status(model_id).get("files") or {}
        except Exception as exc:  # noqa: BLE001
            print(f"  {model_id}: cache status unavailable ({exc})")
            return {}

    # wd and pixai both ship a selected_tags.csv; the shared reader handles the
    # column-name differences between them.
    for model_id in ("wd", "pixai"):
        path = _cached_tag_metadata_file(files_for(model_id))
        if not path:
            print(f"  {model_id}: not downloaded, skipped")
            continue
        before = len(found)
        if str(path).lower().endswith(".json"):
            with open(path, encoding="utf-8") as fh:
                rows = _read_tag_rows_from_json(json.load(fh))
        else:
            with open(path, encoding="utf-8") as fh:
                rows = _read_tag_rows_from_csv(fh)
        for name, _category in rows:
            offer(name)
        print(f"  {model_id}: {len(found) - before} new qualified names")

    metadata_path = _cached_file(files_for("camie"), "camie-tagger-v2-metadata.json")
    if metadata_path:
        before = len(found)
        with open(metadata_path, encoding="utf-8") as fh:
            metadata = json.load(fh)
        mapping = ((metadata.get("dataset_info") or {}).get("tag_mapping") or {})
        for raw in (mapping.get("idx_to_tag") or {}).values():
            offer(str(raw))
        print(f"  camie: {len(found) - before} new qualified names")
    else:
        print("  camie: not downloaded, skipped")

    vocab_path = _cached_file(files_for("cl"), CL_VOCAB_FILE)
    if vocab_path:
        before = len(found)
        idx_to_tag, _categories = _read_cl_vocabulary(Path(vocab_path))
        for raw in idx_to_tag.values():
            offer(str(raw))
        print(f"  cl: {len(found) - before} new qualified names")
    else:
        print("  cl: not downloaded, skipped")

    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write the display names (default is a dry run)")
    args = parser.parse_args()

    from app.config import settings  # type: ignore

    db = Path(settings.database_path)
    if not db.exists():
        print(f"Database not found: {db}", file=sys.stderr)
        return 1

    print(f"Database   : {db}")
    print("Reading tagger vocabularies:")
    names = vocabulary_names()
    if not names:
        print("\nNo tagger vocabularies are downloaded - nothing to read spellings from.")
        return 1

    con = sqlite3.connect(str(db), timeout=30)
    try:
        rows = con.execute(
            "SELECT id, name FROM tags WHERE display_name IS NULL OR display_name = ''"
        ).fetchall()
        updates: list[tuple[int, str, str]] = []
        ambiguous: list[tuple[str, list[str]]] = []
        for tag_id, name in rows:
            spellings = names.get(name)
            if not spellings:
                continue
            if len(spellings) > 1:
                # Two vocabularies put the qualifier in different places. Rare,
                # and a wrong split is worse than the plain fallback.
                ambiguous.append((name, spellings))
                continue
            display = spellings[0]
            if display != name.replace("_", " "):
                updates.append((tag_id, name, display))

        print(f"\nTags without a display name : {len(rows)}")
        print(f"Recoverable spellings       : {len(updates)}")
        print(f"Mode                        : {'APPLY' if args.apply else 'dry run (nothing will be written)'}\n")
        for _tag_id, name, display in updates[:40]:
            print(f"  {name:44} -> {display}")
        if len(updates) > 40:
            print(f"  ... and {len(updates) - 40} more")
        if ambiguous:
            print("\nSkipped as ambiguous (vocabularies disagree):")
            for name, spellings in ambiguous[:10]:
                print(f"  {name:44}    {', '.join(spellings)}")

        if not args.apply:
            print("\nDry run - nothing written. Re-run with --apply to store these.")
            return 0

        con.executemany(
            "UPDATE tags SET display_name = ? WHERE id = ? AND (display_name IS NULL OR display_name = '')",
            [(display, tag_id) for tag_id, _name, display in updates],
        )
        con.commit()
        print(f"\nWrote {len(updates)} display names.")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())
