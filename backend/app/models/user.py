from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint

from ..database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    is_admin = Column(Boolean, nullable=False, default=False)
    # Deactivated rather than deleted so an account can be locked out without
    # orphaning (or requiring reassignment of) the library it owns.
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "isAdmin": bool(self.is_admin),
            "isActive": bool(self.is_active),
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }


class Session(Base):
    """Server-side session backing the httpOnly login cookie.

    The id itself (a random token) is the cookie value, so a lookup is a
    direct primary-key hit; storing it server-side (rather than a signed JWT)
    is what makes logout/deactivation/password-reset take effect instantly.
    """

    __tablename__ = "sessions"

    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_seen_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False, index=True)
    user_agent = Column(String(255), nullable=True)


class ApiToken(Base):
    """Long-lived bearer token for non-cookie clients (browser extension, sync).

    Only the SHA-256 hash is persisted; the raw token is shown to the user
    exactly once, at creation time, the same way ``NEKO_TAGGER_WORKER_TOKEN``
    is handled - it never round-trips back out of the database.
    """

    __tablename__ = "api_tokens"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    label = Column(String(100), nullable=False, default="Extension")
    token_hash = Column(String(64), unique=True, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_used_at = Column(DateTime, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "label": self.label,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "lastUsedAt": self.last_used_at.isoformat() if self.last_used_at else None,
        }


class LibraryShare(Base):
    """A read-only grant: ``owner_id`` lets ``grantee_id`` see their library.

    Owner-managed and off by default - sharing only exists once the owner
    creates a row here, never implicitly (e.g. admins get no free access).
    """

    __tablename__ = "library_shares"
    __table_args__ = (UniqueConstraint("owner_id", "grantee_id", name="uq_library_shares_owner_grantee"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    grantee_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
