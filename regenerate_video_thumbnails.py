"""
Script to regenerate thumbnails for video posts that don't have thumbnails.
Run this after installing ffmpeg to fix existing videos.
"""
import asyncio
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent / "backend"))

from app.database import async_session
from app.models import Post
from app.config import settings
from app.services.media import create_thumbnail, check_ffmpeg_available
from sqlalchemy import select


async def regenerate_thumbnails():
    """Regenerate thumbnails for all video posts missing thumbnails."""
    
    # Check if ffmpeg is available
    if not check_ffmpeg_available():
        print("WARNING: ffmpeg is not installed or not in PATH.")
        print("Video thumbnails cannot be generated without ffmpeg.")
        print("Please install ffmpeg first:")
        print("  - Windows: Download from https://ffmpeg.org/download.html")
        print("            Or use: winget install ffmpeg")
        print("            Or use: choco install ffmpeg")
        print("  - Linux:   sudo apt-get install ffmpeg")
        return  # Exit gracefully - not an error condition
    
    print("ffmpeg is available. Starting thumbnail regeneration...")
    
    async with async_session() as session:
        # Get all video posts
        result = await session.execute(
            select(Post).where(Post.extension.in_([".webm", ".mp4"]))
        )
        video_posts = result.scalars().all()
        
        print(f"Found {len(video_posts)} video posts")
        
        regenerated = 0
        skipped = 0
        failed = 0
        
        for post in video_posts:
            # Check if thumbnail exists
            thumb_path = settings.thumbs_dir / post.thumb_path
            content_path = settings.posts_dir / post.content_path
            
            if thumb_path.exists():
                print(f"  Post {post.id}: Thumbnail already exists, skipping")
                skipped += 1
                continue
            
            if not content_path.exists():
                print(f"  Post {post.id}: Video file not found at {content_path}, skipping")
                skipped += 1
                continue
            
            # Create thumbnail
            print(f"  Post {post.id}: Creating thumbnail...")
            success = create_thumbnail(content_path, thumb_path, post.extension)
            
            if success:
                print(f"  Post {post.id}: ✓ Thumbnail created successfully")
                regenerated += 1
            else:
                print(f"  Post {post.id}: ✗ Failed to create thumbnail")
                failed += 1
        
        print("\n" + "="*50)
        print(f"Summary:")
        print(f"  Regenerated: {regenerated}")
        print(f"  Skipped: {skipped}")
        print(f"  Failed: {failed}")
        print("="*50)


if __name__ == "__main__":
    try:
        asyncio.run(regenerate_thumbnails())
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"Error during thumbnail regeneration: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
