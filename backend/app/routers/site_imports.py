from fastapi import APIRouter, Depends, HTTPException

from ..dependencies import get_current_user
from ..models import User
from ..services.site_imports import gelbooru_post_for_import

router = APIRouter(prefix="/api/site-imports", tags=["site-imports"])


@router.get("/gelbooru/{post_id}")
async def get_gelbooru_import(post_id: int, current_user: User = Depends(get_current_user)):
    """Resolve a Gelbooru post to its original file and source tag metadata."""
    try:
        return await gelbooru_post_for_import(post_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
