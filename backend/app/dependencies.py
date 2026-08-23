from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from .database import get_db
from .models import User
from .services.auth import get_api_token_user, get_session_user

SESSION_COOKIE_NAME = "neko_session"


async def get_current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    if session_id:
        user = await get_session_user(db, session_id)
        if user is not None and user.is_active:
            return user

    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        user = await get_api_token_user(db, auth_header[7:].strip())
        if user is not None and user.is_active:
            return user

    raise HTTPException(status_code=401, detail="Not authenticated")


async def get_current_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return current_user
