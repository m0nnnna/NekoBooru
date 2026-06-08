import sys
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .config import settings, get_bundle_dir
from .database import init_db
from .routers import uploads, posts, tags, pools, notes, comments, sync, auto_tags, runtime, settings as settings_router

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # Initialize database
    await init_db()
    from .services import ytdlp_manager

    await ytdlp_manager.maybe_update_on_startup()
    yield


app = FastAPI(
    title=settings.app_name,
    description="A lightweight, local booru-style image/video gallery",
    version="4.0.0",
    lifespan=lifespan,
)

# CORS middleware. Restricted to local origins by default (see
# settings.cors_origins). The app uses no cookies/auth, so credentials are not
# allowed; widen NEKO_CORS_ORIGINS only if you deliberately serve the web UI to
# another device's browser.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers (must be before static file serving)
app.include_router(uploads.router)
app.include_router(posts.router)
app.include_router(tags.router)
app.include_router(pools.router)
app.include_router(notes.router)
app.include_router(comments.router)
app.include_router(sync.router)
app.include_router(auto_tags.router)
app.include_router(runtime.router)
app.include_router(settings_router.router)


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": settings.app_name}


@app.get("/api/info")
async def get_info():
    """Get server information."""
    return {
        "name": settings.app_name,
        "version": "4.0.0",
    }


@app.get("/api/stats")
async def get_stats():
    """Get database statistics."""
    from sqlalchemy import select, func
    from .database import async_session
    from .models import Post, Tag, Pool

    async with async_session() as session:
        post_count = await session.execute(select(func.count(Post.id)))
        tag_count = await session.execute(select(func.count(Tag.id)))
        pool_count = await session.execute(select(func.count(Pool.id)))

        return {
            "posts": post_count.scalar() or 0,
            "tags": tag_count.scalar() or 0,
            "pools": pool_count.scalar() or 0,
        }


@app.get("/api/debug/paths")
async def debug_paths():
    """Debug endpoint to check frontend path resolution."""
    frozen = getattr(sys, 'frozen', False)
    bundle_dir = get_bundle_dir()

    return {
        "frozen": frozen,
        "bundle_dir": str(bundle_dir.resolve()),
        "base_dir": str(settings.base_dir.resolve()),
        "data_dir": str(settings.data_dir),
        "config_dir": str(settings.config_dir),
        "logs_dir": str(settings.logs_dir),
        "frontend_found": frontend_dist is not None,
        "frontend_path": str(frontend_dist.resolve()) if frontend_dist else None,
    }


# Honest 404 for unmatched API paths. Must be registered after every real API
# route (concrete routes match first) but before the SPA catch-all below.
# Otherwise an unknown /api route falls through to ``GET /{full_path:path}`` and
# a non-GET request returns a confusing 405 Method Not Allowed instead of 404.
@app.api_route(
    "/api/{rest:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    include_in_schema=False,
)
async def api_not_found(rest: str):
    from fastapi import HTTPException

    raise HTTPException(status_code=404, detail="Not found")


# Serve static files in production (must be after all API routes)
# Check if frontend build exists (relative to backend directory)
# Try multiple paths to find frontend build
def find_frontend_path():
    """Find the frontend build directory."""
    bundle_dir = get_bundle_dir()

    possible_paths = [
        Path(__file__).parent.parent.parent / "frontend" / "dist",   # Development: backend/../frontend/dist
        bundle_dir / "frontend" / "dist",                            # PyInstaller/dev bundle with dist nested
        bundle_dir / "frontend",                                     # PyInstaller bundle or build distribution
        Path(__file__).parent.parent.parent / "frontend",            # Build: nekobooru-windows/frontend
        Path(__file__).parent.parent / "frontend",                   # Alternative build path
        Path(__file__).parent.parent / "frontend" / "dist",          # Alternative dev path
    ]

    for path in possible_paths:
        path = path.resolve()
        if path.exists() and (path / "index.html").exists():
            logger.info(f"Found frontend build at: {path}")
            return path

    logger.warning("Frontend build not found. API-only mode. Tried paths:")
    for path in possible_paths:
        logger.warning(f"  - {path.resolve()}")
    return None

frontend_dist = find_frontend_path()

if frontend_dist:
    # Serve static assets
    assets_dir = frontend_dist / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")
        logger.info(f"Serving static assets from: {assets_dir}")
    else:
        logger.warning(f"Assets directory not found at: {assets_dir}")
    
    # Serve index.html for all non-API routes (must be last route)
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """Serve frontend for all non-API routes."""
        # Don't interfere with API or media routes
        if full_path.startswith("api/") or full_path.startswith("media/"):
            from fastapi import HTTPException
            raise HTTPException(status_code=404)
        # Check if the requested path is an actual static file in frontend dist
        if full_path:
            static_file = frontend_dist / full_path
            if static_file.is_file():
                return FileResponse(str(static_file))
        # Fall back to index.html for SPA routing
        index_path = frontend_dist / "index.html"
        if index_path.exists():
            return FileResponse(str(index_path))
        from fastapi import HTTPException
        raise HTTPException(status_code=404)
