from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..dependencies import get_current_user
from ..models import User
from ..services.site_imports import danbooru_names, gelbooru_post_for_import, gelbooru_search_for_import

router = APIRouter(prefix="/api/site-imports", tags=["site-imports"])


class GelbooruSearchRequest(BaseModel):
    tags: str = ""
    offset: int = 0
    ids: list[int] = []


class DanbooruNamesRequest(BaseModel):
    tags: list[str] = []
    tagCategories: dict[str, str] = {}


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


@router.post("/gelbooru-search")
async def get_gelbooru_search_import(request: GelbooruSearchRequest, current_user: User = Depends(get_current_user)):
    """Resolve the posts on one Gelbooru search page to their originals and tags."""
    try:
        return await gelbooru_search_for_import(request.tags, request.offset, request.ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/danbooru-names")
async def get_danbooru_names(request: DanbooruNamesRequest, current_user: User = Depends(get_current_user)):
    """Danbooru's spelling for imported character/copyright tags that differ.

    Sankaku writes honoka_(dead_or_alive) where Danbooru, Gelbooru, and
    Safebooru write honoka_(doa); imports rename to the Danbooru form.
    """
    return {"renames": await danbooru_names(request.tags[:500], request.tagCategories)}
