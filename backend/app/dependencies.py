from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from .database import async_session
from .models import User
from .services.auth import get_api_token_user, get_session_user

SESSION_COOKIE_NAME = "neko_session"


async def get_current_user(request: Request) -> User:
    """Resolve the logged-in user from a session cookie or a bearer token.

    Uses its own short-lived session rather than ``Depends(get_db)``, which
    would otherwise stay open (via FastAPI's per-request dependency caching)
    for the whole request - including while an endpoint that never even
    declares a ``db`` parameter itself calls into a service that opens its
    *own* separate session (e.g. auto_tag_jobs.py's preview_post/apply_post),
    which deadlocks SQLite with "database is locked". Closing this one before
    the endpoint body runs avoids ever holding two connections open at once.
    """
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    if session_id:
        async with async_session() as db:
            user = await get_session_user(db, session_id)
            if user is not None and user.is_active:
                await db.commit()  # persist the last_seen_at bump
                return user

    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        async with async_session() as db:
            user = await get_api_token_user(db, auth_header[7:].strip())
            if user is not None and user.is_active:
                await db.commit()  # persist the last_used_at bump
                return user

    raise HTTPException(status_code=401, detail="Not authenticated")


async def get_current_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return current_user
