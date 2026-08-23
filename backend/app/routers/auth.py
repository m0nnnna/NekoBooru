from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..dependencies import SESSION_COOKIE_NAME, get_current_admin, get_current_user
from ..models import (
    ApiToken,
    AutoTagJob,
    Favorite,
    LibraryShare,
    Pool,
    Post,
    SyncLog,
    UploadJob,
    User,
)
from ..services.auth import (
    create_session,
    generate_api_token,
    hash_password,
    revoke_session,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

_COOKIE_MAX_AGE = settings.session_ttl_days * 24 * 60 * 60


class BootstrapAdminRequest(BaseModel):
    username: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    isAdmin: bool = False


class UpdateUserRequest(BaseModel):
    isActive: bool | None = None
    isAdmin: bool | None = None
    password: str | None = None


class SharesRequest(BaseModel):
    granteeUsernames: list[str]


class CreateTokenRequest(BaseModel):
    label: str = "Extension"


def _set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_id,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )


async def _has_any_user(db: AsyncSession) -> bool:
    result = await db.execute(select(func.count(User.id)))
    return (result.scalar() or 0) > 0


@router.get("/status")
async def auth_status(db: AsyncSession = Depends(get_db)):
    return {"hasUsers": await _has_any_user(db)}


@router.post("/bootstrap-admin")
async def bootstrap_admin(payload: BootstrapAdminRequest, response: Response, db: AsyncSession = Depends(get_db)):
    if await _has_any_user(db):
        raise HTTPException(status_code=409, detail="An admin account already exists")
    if not payload.username.strip() or not payload.password:
        raise HTTPException(status_code=422, detail="Username and password are required")

    admin = User(
        username=payload.username.strip(),
        password_hash=hash_password(payload.password),
        is_admin=True,
        is_active=True,
    )
    db.add(admin)
    await db.flush()

    # Backfill: every pre-existing row (this was a single-user install before
    # this moment) becomes the new admin's library. Tag rows in sync_log stay
    # global - they're shared vocabulary, not private content.
    await db.execute(update(Post).where(Post.owner_id.is_(None)).values(owner_id=admin.id))
    await db.execute(update(Pool).where(Pool.owner_id.is_(None)).values(owner_id=admin.id))
    await db.execute(update(UploadJob).where(UploadJob.owner_id.is_(None)).values(owner_id=admin.id))
    await db.execute(update(AutoTagJob).where(AutoTagJob.owner_id.is_(None)).values(owner_id=admin.id))
    await db.execute(update(Favorite).where(Favorite.user_id.is_(None)).values(user_id=admin.id))
    await db.execute(
        update(SyncLog)
        .where(SyncLog.user_id.is_(None), SyncLog.entity_type != "tag")
        .values(user_id=admin.id)
    )

    session_id = await create_session(db, admin.id)
    await db.commit()
    _set_session_cookie(response, session_id)
    return admin.to_dict()


@router.post("/login")
async def login(payload: LoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.username == payload.username.strip()))
    user = result.scalars().first()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="This account has been deactivated")

    session_id = await create_session(db, user.id, request.headers.get("user-agent"))
    await db.commit()
    _set_session_cookie(response, session_id)
    return user.to_dict()


@router.post("/logout")
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    if session_id:
        await revoke_session(db, session_id)
        await db.commit()
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
async def me(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    shared_with_me = await db.execute(
        select(User.username)
        .join(LibraryShare, LibraryShare.owner_id == User.id)
        .where(LibraryShare.grantee_id == current_user.id)
    )
    data = current_user.to_dict()
    data["sharedWithMe"] = [row[0] for row in shared_with_me.all()]
    return data


# ---------------------------------------------------------------------------
# Admin: user management
# ---------------------------------------------------------------------------

@router.get("/users")
async def list_users(admin: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).order_by(User.username))
    return [u.to_dict() for u in result.scalars().all()]


@router.post("/users")
async def create_user(
    payload: CreateUserRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    username = payload.username.strip()
    if not username or not payload.password:
        raise HTTPException(status_code=422, detail="Username and password are required")
    existing = await db.execute(select(User).where(User.username == username))
    if existing.scalars().first() is not None:
        raise HTTPException(status_code=409, detail="That username is already taken")

    user = User(
        username=username,
        password_hash=hash_password(payload.password),
        is_admin=payload.isAdmin,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    return user.to_dict()


@router.patch("/users/{user_id}")
async def update_user(
    user_id: int,
    payload: UpdateUserRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalars().first()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.isActive is not None:
        if user.id == admin.id and not payload.isActive:
            raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
        user.is_active = payload.isActive
    if payload.isAdmin is not None:
        if user.id == admin.id and not payload.isAdmin:
            raise HTTPException(status_code=400, detail="You cannot remove your own admin access")
        user.is_admin = payload.isAdmin
    if payload.password:
        user.password_hash = hash_password(payload.password)

    await db.commit()
    return user.to_dict()


# ---------------------------------------------------------------------------
# Self-service: library sharing
# ---------------------------------------------------------------------------

@router.get("/shares")
async def list_shares(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    shared_by_me = await db.execute(
        select(User.username)
        .join(LibraryShare, LibraryShare.grantee_id == User.id)
        .where(LibraryShare.owner_id == current_user.id)
    )
    shared_with_me = await db.execute(
        select(User.username)
        .join(LibraryShare, LibraryShare.owner_id == User.id)
        .where(LibraryShare.grantee_id == current_user.id)
    )
    return {
        "sharedByMe": [row[0] for row in shared_by_me.all()],
        "sharedWithMe": [row[0] for row in shared_with_me.all()],
    }


@router.put("/shares")
async def set_shares(
    payload: SharesRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    usernames = {name.strip() for name in payload.granteeUsernames if name.strip()}
    result = await db.execute(select(User).where(User.username.in_(usernames)))
    grantees = result.scalars().all()
    found_usernames = {u.username for u in grantees}
    missing = usernames - found_usernames
    if missing:
        raise HTTPException(status_code=404, detail=f"Unknown user(s): {', '.join(sorted(missing))}")

    existing = await db.execute(select(LibraryShare).where(LibraryShare.owner_id == current_user.id))
    for share in existing.scalars().all():
        await db.delete(share)
    for grantee in grantees:
        if grantee.id == current_user.id:
            continue
        db.add(LibraryShare(owner_id=current_user.id, grantee_id=grantee.id))

    await db.commit()
    return {"sharedByMe": sorted(u.username for u in grantees if u.id != current_user.id)}


# ---------------------------------------------------------------------------
# Self-service: API tokens (browser extension / sync clients)
# ---------------------------------------------------------------------------

@router.get("/tokens")
async def list_tokens(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ApiToken).where(ApiToken.user_id == current_user.id).order_by(ApiToken.created_at)
    )
    return [t.to_dict() for t in result.scalars().all()]


@router.post("/tokens")
async def create_token(
    payload: CreateTokenRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    token, raw_token = await generate_api_token(db, current_user.id, payload.label)
    await db.commit()
    data = token.to_dict()
    data["token"] = raw_token
    return data


@router.delete("/tokens/{token_id}")
async def delete_token(
    token_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ApiToken).where(ApiToken.id == token_id, ApiToken.user_id == current_user.id)
    )
    token = result.scalars().first()
    if token is None:
        raise HTTPException(status_code=404, detail="Token not found")
    await db.delete(token)
    await db.commit()
    return {"ok": True}
