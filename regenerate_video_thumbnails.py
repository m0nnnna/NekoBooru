"""
Script to regenerate thumbnails for posts that are missing them, or to force-
regenerate all thumbnails.

Covers: .mp4, .webm (via ffmpeg), .gif (via Pillow), .jpg/.jpeg/.png/.webp

Usage:
  python regenerate_video_thumbnails.py           # only missing thumbnails
  python regenerate_video_thumbnails.py --force   # overwrite all thumbnails
  python regenerate_video_thumbnails.py --type gif        # only GIFs
  python regenerate_video_thumbnails.py --type video      # only MP4/WebM
  python regenerate_video_thumbnails.py --type all        # everything
"""
import argparse
import asyncio
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent / "backend"))

from app.config import settings
from app.database import async_session
from app.models import Post
from app.services.media import check_ffmpeg_available, create_thumbnail
from sqlalchemy import select

VIDEO_EXTS = {".mp4", ".webm"}
GIF_EXTS = {".gif"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def ext_set_for_type(media_type: str) -> set:
    if media_type == "video":
        return VIDEO_EXTS
    if media_type == "gif":
        return GIF_EXTS
    if media_type == "image":
        return IMAGE_EXTS
    # "all"
    return VIDEO_EXTS | GIF_EXTS | IMAGE_EXTS


async def regenerate_thumbnails(force: bool = False, media_type: str = "all"):
    target_exts = ext_set_for_type(media_type)

    needs_video = bool(target_exts & VIDEO_EXTS)
    ffmpeg_ok = check_ffmpeg_available()

    if needs_video and not ffmpeg_ok:
        print("WARNING: ffmpeg is not installed or not in PATH.")
        print("Video (.mp4/.webm) thumbnails will be skipped.")
        print("  - Windows: winget install ffmpeg  /  choco install ffmpeg")
        print("  - Linux:   sudo apt-get install ffmpeg")
        print()
        # Still process non-video types
        target_exts = target_exts - VIDEO_EXTS
        if not target_exts:
            return

    print(f"Target types : {', '.join(sorted(target_exts))}")
    print(f"Force mode   : {'yes — overwriting existing thumbnails' if force else 'no — skipping existing thumbnails'}")
    print()

    async with async_session() as session:
        result = await session.execute(
            select(Post).where(Post.extension.in_(target_exts))
        )
        posts = result.scalars().all()

    print(f"Found {len(posts)} post(s) to check.")
    print()

    regenerated = 0
    skipped = 0
    failed = 0

    for post in posts:
        # Build paths manually from sha256 (same layout as move_to_storage)
        subdir = post.sha256[:2]
        content_path = settings.posts_dir / subdir / f"{post.sha256}{post.extension}"
        thumb_path = settings.thumbs_dir / subdir / f"{post.sha256}.jpg"

        if not content_path.exists():
            print(f"  [{post.id}] SKIP  — source file missing: {content_path}")
            skipped += 1
            continue

        if thumb_path.exists() and not force:
            skipped += 1
            continue

        success = create_thumbnail(content_path, thumb_path, post.extension)

        if success:
            print(f"  [{post.id}] OK    — {post.extension}  {content_path.name}")
            regenerated += 1
        else:
            print(f"  [{post.id}] FAIL  — {post.extension}  {content_path.name}")
            failed += 1

    print()
    print("=" * 50)
    print(f"  Regenerated : {regenerated}")
    print(f"  Skipped     : {skipped}")
    print(f"  Failed      : {failed}")
    print("=" * 50)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Regenerate post thumbnails")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite thumbnails that already exist",
    )
    parser.add_argument(
        "--type",
        choices=["all", "video", "gif", "image"],
        default="all",
        help="Which media types to process (default: all)",
    )
    args = parser.parse_args()

    try:
        asyncio.run(regenerate_thumbnails(force=args.force, media_type=args.type))
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
