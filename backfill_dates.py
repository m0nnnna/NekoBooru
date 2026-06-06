#!/usr/bin/env python
"""Backfill post created_at dates after an import.

For each media file under the given folder(s), find the matching post (by
SHA-256 — the DB stores a UUID filename, so the content hash is the reliable
link) and set its ``created_at`` to:

  * the tweet's real timestamp, decoded from a Twitter Media Harvest filename
    (``<handle>-<tweetId>-...``), since Twitter/X Snowflake IDs embed their
    creation time; or
  * the file's modification time (mtime) when no tweet id is present.

Pairs with ``batch_import.py --twitter``. Run with the project venv:

    venv\\Scripts\\python.exe backfill_dates.py "C:/Users/beast/Downloads/twitter_media_harvest"

Use --dry-run first to preview. Stored datetimes are naive UTC in
SQLAlchemy's SQLite format ("%Y-%m-%d %H:%M:%S.%f") so the app reads them back.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".webm", ".mp4"}
TWITTER_NAME = re.compile(r"^([A-Za-z0-9_]+)-(\d{6,})(?:-\d+)?$")
SNOWFLAKE_EPOCH_MS = 1288834974657  # Twitter/X epoch (2010-11-04)


def db_path_from_config() -> Path:
    """Resolve the live database path from the backend settings."""
    sys.path.insert(0, str(Path(__file__).parent / "backend"))
    from app.config import settings  # type: ignore
    return Path(settings.database_path)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _naive_utc(epoch_seconds: float) -> datetime:
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).replace(tzinfo=None)


def desired_date(path: Path) -> tuple[datetime, str]:
    """(datetime, kind) where kind is 'tweet' or 'mtime'."""
    m = TWITTER_NAME.match(path.stem)
    if m:
        ms = (int(m.group(2)) >> 22) + SNOWFLAKE_EPOCH_MS
        return _naive_utc(ms / 1000), "tweet"
    return _naive_utc(path.stat().st_mtime), "mtime"


def sqlite_dt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")


def iter_media(roots):
    for root in roots:
        root = Path(root)
        if root.is_file():
            if root.suffix.lower() in SUPPORTED_EXTS:
                yield root
            continue
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                p = Path(dirpath) / name
                if p.suffix.lower() in SUPPORTED_EXTS:
                    yield p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Backfill post created_at from tweet id / mtime.")
    ap.add_argument("folders", nargs="+", help="Imported folder(s) to read dates from.")
    ap.add_argument("--db", default=None, help="Path to nekobooru.db (default: from backend config).")
    ap.add_argument("--dry-run", action="store_true", help="Preview counts; change nothing.")
    args = ap.parse_args(argv)

    db = Path(args.db) if args.db else db_path_from_config()
    print("DB:", db)
    if not db.exists():
        print("ERROR: database not found.")
        return 1

    files = list(iter_media(args.folders))
    print(f"{len(files)} source media file(s)")

    # sha256 -> (datetime, kind); prefer a tweet date over an mtime on collision.
    plan: dict[str, tuple[datetime, str]] = {}
    for p in files:
        try:
            sha = sha256_of(p)
            dt, kind = desired_date(p)
        except OSError as e:
            print(f"! skip {p}: {e}")
            continue
        if sha not in plan or (kind == "tweet" and plan[sha][1] == "mtime"):
            plan[sha] = (dt, kind)

    con = sqlite3.connect(str(db), timeout=30)
    con.execute("PRAGMA busy_timeout=30000")
    updated = tweet_n = mtime_n = missing = 0
    try:
        for sha, (dt, kind) in plan.items():
            row = con.execute("SELECT id FROM posts WHERE sha256=?", (sha,)).fetchone()
            if not row:
                missing += 1
                continue
            if not args.dry_run:
                con.execute("UPDATE posts SET created_at=? WHERE sha256=?", (sqlite_dt(dt), sha))
            updated += 1
            if kind == "tweet":
                tweet_n += 1
            else:
                mtime_n += 1
        if not args.dry_run:
            con.commit()
    finally:
        con.close()

    verb = "(dry-run) would set" if args.dry_run else "set"
    print(f"{verb} created_at on {updated} post(s)  "
          f"[tweet-date: {tweet_n}, file-mtime: {mtime_n}]  no-match-in-db: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
