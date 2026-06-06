#!/usr/bin/env python
"""NekoBooru batch importer.

Recursively import one or more folders of media into a running NekoBooru
instance. Each post is tagged with the name of the folder the file sits in
(e.g. a file in ``D:/pics/cats/`` gets the tag ``cats``).

Originals are KEPT by default. Pass --move to delete each source file, and
only after it has been confirmed stored on the server (newly uploaded *or*
already present as a duplicate).

Duplicates are detected server-side by content hash, so re-running over the
same folders is safe and resumes where it left off.

Examples
--------
    python batch_import.py "D:/pics/cats" "D:/pics/dogs"
    python batch_import.py --dry-run "D:/pics"
    python batch_import.py --move --workers 6 "E:/to-import"

Run it with the project venv so ``requests`` is available:
    venv\\Scripts\\python.exe batch_import.py "D:/pics"

The backend URL defaults to http://localhost:8770 (override with --url or the
NEKO_IMPORT_URL environment variable).
"""
from __future__ import annotations

import argparse
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

# Media types NekoBooru accepts (mirrors the backend's allowed_extensions).
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".webm", ".mp4"}

# Per-thread HTTP session: requests.Session isn't guaranteed thread-safe to
# share across threads, so each worker gets its own.
_local = threading.local()


def session_for_thread() -> requests.Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"Accept": "application/json"})
        _local.session = s
    return s


def normalize_tag(raw: str) -> str:
    """Match the web UI's tag normalisation: lowercase, whitespace -> '_'."""
    tag = re.sub(r"\s+", "_", raw.strip().lower())
    return re.sub(r"_+", "_", tag).strip("_")


# Twitter Media Harvest names files "<handle>-<tweetId>-<serial>.<ext>".
TWITTER_NAME = re.compile(r"^([A-Za-z0-9_]+)-(\d{6,})(?:-\d+)?$")


def twitter_tags(path: Path) -> list[str] | None:
    """[handle, tweet_<id>] parsed from a Twitter Media Harvest filename, or None."""
    m = TWITTER_NAME.match(path.stem)
    if not m:
        return None
    return [m.group(1), f"tweet_{m.group(2)}"]


def auto_tags(path: Path) -> list[str]:
    """Hook for future auto-tagging (e.g. DeepDanbooru via Ollama).

    Return extra tag strings for a given file. Currently a no-op — wire your
    model in here and whatever it returns is merged + normalised alongside the
    folder tag, so the rest of the importer needs no changes.
    """
    return []


def derive_tags(path: Path, args) -> list[str]:
    """Tags for a file (+ any --extra-tags, + auto_tags), normalised & deduped.

    --twitter: parse <handle>-<tweetid> filenames into [account, tweet_<id>];
    files that don't match fall back to the filename itself. Otherwise the tag
    is the source folder name (unless --no-folder-tag).
    """
    raw: list[str] = []
    handled = False
    if getattr(args, "twitter", False):
        tw = twitter_tags(path)
        raw.extend(tw if tw else [path.stem])  # fallback: the filename
        handled = True
    if not handled and args.folder_tag and path.parent.name:
        raw.append(path.parent.name)
    raw.extend(args.extra_tags)
    raw.extend(auto_tags(path))

    seen: set[str] = set()
    out: list[str] = []
    for t in (normalize_tag(t) for t in raw):
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def iter_media(roots: list[Path]):
    """Yield every supported media file under the given files/folders."""
    for root in roots:
        if root.is_file():
            if root.suffix.lower() in SUPPORTED_EXTS:
                yield root
            continue
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                p = Path(dirpath) / name
                if p.suffix.lower() in SUPPORTED_EXTS:
                    yield p


def import_one(path: Path, args) -> tuple[str, str]:
    """Import a single file. Returns (status, detail).

    status is one of: 'uploaded', 'duplicate', 'failed'.
    """
    s = session_for_thread()
    try:
        # Step 1: stage the bytes, get a token (file object is streamed).
        with open(path, "rb") as fh:
            r = s.post(
                f"{args.url}/api/uploads",
                files={"content": (path.name, fh)},
                timeout=args.timeout,
            )
        if r.status_code != 200:
            return "failed", f"upload HTTP {r.status_code}: {r.text[:200]}"
        token = r.json().get("token")
        if not token:
            return "failed", "no upload token returned"

        # Step 2: create the post (this is where the file is hashed, moved into
        # storage, thumbnailed, and recorded in the DB).
        body = {"contentToken": token, "safety": args.safety, "tags": derive_tags(path, args)}
        r2 = s.post(f"{args.url}/api/posts", json=body, timeout=args.timeout)
        if r2.status_code == 200:
            status = "uploaded"
        elif r2.status_code == 409:
            status = "duplicate"  # already in the library (same content hash)
        else:
            return "failed", f"post HTTP {r2.status_code}: {r2.text[:200]}"

        # Stored successfully -> optionally remove the source.
        if args.move:
            try:
                path.unlink()
            except OSError as e:
                return status, f"stored but could not delete source: {e}"
        return status, ""
    except requests.RequestException as e:
        return "failed", f"network error: {e}"
    except OSError as e:
        return "failed", f"file error: {e}"


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Batch-import folders into NekoBooru.")
    ap.add_argument("folders", nargs="+", help="Folder(s) or file(s) to import (recursed).")
    ap.add_argument("--url", default=os.environ.get("NEKO_IMPORT_URL", "http://localhost:8770"),
                    help="NekoBooru base URL (default: %(default)s).")
    ap.add_argument("--move", action="store_true",
                    help="Delete each source file after it is safely stored (default: keep).")
    ap.add_argument("--safety", choices=["safe", "sketchy", "unsafe"], default="safe",
                    help="Safety rating for imported posts (default: safe).")
    ap.add_argument("--no-folder-tag", dest="folder_tag", action="store_false",
                    help="Do not tag posts with their source folder name.")
    ap.add_argument("--twitter", action="store_true",
                    help="Tag from Twitter Media Harvest filenames "
                         "(<handle>-<tweetid> -> account tag + tweet_<id> tag); "
                         "files that don't match fall back to the filename.")
    ap.add_argument("--extra-tags", default="",
                    help="Comma-separated tags added to every imported post.")
    ap.add_argument("--workers", type=int, default=4, help="Concurrent uploads (default: 4).")
    ap.add_argument("--timeout", type=float, default=300.0,
                    help="Per-request timeout in seconds (default: 300).")
    ap.add_argument("--dry-run", action="store_true",
                    help="List what would be imported; upload nothing.")
    args = ap.parse_args(argv)
    args.url = args.url.rstrip("/")
    args.extra_tags = [t for t in args.extra_tags.split(",") if t.strip()]
    return args


def main(argv=None) -> int:
    args = parse_args(argv)

    roots: list[Path] = []
    for f in args.folders:
        p = Path(f).expanduser()
        if p.exists():
            roots.append(p)
        else:
            print(f"! skipping (not found): {p}")
    if not roots:
        print("No valid folders given.")
        return 2

    files = list(iter_media(roots))
    print(f"Found {len(files)} media file(s) under {len(roots)} path(s).")
    if not files:
        return 0

    if args.dry_run:
        for p in files:
            print(f"  would import {p}   tags={derive_tags(p, args)}")
        print(f"\nDry run — nothing uploaded ({len(files)} files).")
        return 0

    # Fail fast if the backend isn't reachable.
    try:
        requests.get(f"{args.url}/api/health", timeout=10).raise_for_status()
    except requests.RequestException as e:
        print(f"ERROR: backend not reachable at {args.url} ({e}).")
        print("Is the server running, and is --url correct? (default :8770)")
        return 1

    counts = {"uploaded": 0, "duplicate": 0, "failed": 0}
    total = len(files)
    done = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        future_to_path = {ex.submit(import_one, p, args): p for p in files}
        for fut in as_completed(future_to_path):
            p = future_to_path[fut]
            status, detail = fut.result()
            counts[status] += 1
            done += 1
            tail = f" - {detail}" if detail else ""
            print(f"[{done}/{total}] {status:<9} {p}{tail}")

    print("\n=== Import complete ===")
    print(f"  uploaded:  {counts['uploaded']}")
    print(f"  duplicate: {counts['duplicate']} (already in library)")
    print(f"  failed:    {counts['failed']}")
    if args.move:
        print("  source files for stored items were deleted (--move).")
    return 0 if counts["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
