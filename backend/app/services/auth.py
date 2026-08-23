from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models import ApiToken, LibraryShare, Session, User

_PBKDF2_ITERATIONS = 600_000
_PBKDF2_ALGO = "sha256"


def hash_password(raw: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(_PBKDF2_ALGO, raw.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_{_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(raw: str, stored: str) -> bool:
    try:
        algo_label, iterations_str, salt_hex, digest_hex = stored.split("$")
        algo = algo_label.split("_", 1)[1]
        iterations = int(iterations_str)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except (ValueError, IndexError):
        return False
    candidate = hashlib.pbkdf2_hmac(algo, raw.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)


async def create_session(db: AsyncSession, user_id: int, user_agent: str | None = None) -> str:
    session_id = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(days=settings.session_ttl_days)
    db.add(
        Session(
            id=session_id,
            user_id=user_id,
            expires_at=expires_at,
            user_agent=(user_agent or "")[:255],
        )
    )
    await db.flush()
    return session_id


async def get_session_user(db: AsyncSession, session_id: str) -> User | None:
    if not session_id:
        return None
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalars().first()
    if session is None or session.expires_at < datetime.utcnow():
        return None
    session.last_seen_at = datetime.utcnow()
    user_result = await db.execute(select(User).where(User.id == session.user_id))
    return user_result.scalars().first()


async def revoke_session(db: AsyncSession, session_id: str) -> None:
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalars().first()
    if session is not None:
        await db.delete(session)


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


async def generate_api_token(db: AsyncSession, user_id: int, label: str) -> tuple[ApiToken, str]:
    raw_token = secrets.token_urlsafe(32)
    token = ApiToken(user_id=user_id, label=label or "Extension", token_hash=_hash_token(raw_token))
    db.add(token)
    await db.flush()
    return token, raw_token


async def get_api_token_user(db: AsyncSession, raw_token: str) -> User | None:
    if not raw_token:
        return None
    token_hash = _hash_token(raw_token)
    result = await db.execute(select(ApiToken).where(ApiToken.token_hash == token_hash))
    token = result.scalars().first()
    if token is None:
        return None
    token.last_used_at = datetime.utcnow()
    user_result = await db.execute(select(User).where(User.id == token.user_id))
    return user_result.scalars().first()


async def visible_owner_ids(db: AsyncSession, user: User) -> list[int]:
    """This user's own id plus every owner who has shared their library with them."""
    result = await db.execute(
        select(LibraryShare.owner_id)
        .join(User, User.id == LibraryShare.owner_id)
        .where(LibraryShare.grantee_id == user.id, User.is_active.is_(True))
    )
    shared_owner_ids = [row[0] for row in result.all()]
    return [user.id, *shared_owner_ids]
