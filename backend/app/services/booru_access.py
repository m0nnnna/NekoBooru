from __future__ import annotations

from fastapi import Depends, HTTPException

from ..config import settings
from ..dependencies import get_current_user
from ..models import User
from .settings import SettingsManager

DISABLED_MESSAGE = "Booru search is disabled on this instance. An admin can enable it in Settings."


def booru_search_enabled() -> bool:
    """The instance-wide admin switch, read from settings.json."""
    return SettingsManager(settings.config_file).get_booru_search_settings().get("enabled") is True


def booru_search_allowed(user: User) -> bool:
    """The single place that decides whether ``user`` may browse and import from boorus.

    Today this is just the instance switch. Per-user access later means: a
    ``User.can_browse_boorus`` column, a checkbox on the admin Users page, and
    one more condition here - no endpoint or UI change.
    """
    return booru_search_enabled()


async def require_booru_search(current_user: User = Depends(get_current_user)) -> User:
    if not booru_search_allowed(current_user):
        raise HTTPException(status_code=403, detail={"code": "booru_search_disabled", "message": DISABLED_MESSAGE})
    return current_user
