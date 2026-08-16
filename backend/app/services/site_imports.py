"""Metadata needed by one-click imports from supported source sites."""
from __future__ import annotations

import httpx

from .booru_suggest import gelbooru_credentials

GELBOORU = "https://gelbooru.com"
USER_AGENT = "NekoBooru/1.0 (Gelbooru original importer)"
DEFAULT_TIMEOUT = 10.0
TAG_TYPE_TO_CATEGORY = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
    6: "meta",
}


def _rows(payload, key: str) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    rows = payload.get(key)
    if isinstance(rows, dict):
        return [rows]
    return [row for row in (rows or []) if isinstance(row, dict)]


async def _fetch_json(params: dict[str, str | int], timeout: float):
    # booru_suggest installs an httpx logging filter that redacts api_key. Use
    # params separately as well, so credentials never become a string built or
    # logged by this service. httpx's CA bundle is also more reliable than the
    # host Python urllib trust chain on Windows.
    try:
        async with httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT},
            timeout=timeout,
            follow_redirects=True,
        ) as client:
            response = await client.get(f"{GELBOORU}/index.php", params=params)
    except httpx.HTTPError as exc:
        raise RuntimeError("Gelbooru could not be reached") from exc
    if response.status_code in {401, 403}:
        raise PermissionError("Gelbooru rejected the saved API credentials")
    if response.status_code >= 400:
        raise RuntimeError(f"Gelbooru returned HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError("Gelbooru returned an invalid response") from exc


def _auth_params() -> dict[str, str]:
    credentials = gelbooru_credentials()
    if not credentials:
        raise PermissionError("Gelbooru API credentials are not configured in NekoBooru Settings")
    user_id, api_key = credentials
    return {"user_id": user_id, "api_key": api_key}


def _safety(rating: str) -> str:
    value = str(rating or "").strip().lower()
    if value in {"e", "explicit"}:
        return "unsafe"
    if value in {"q", "questionable", "s", "sensitive"}:
        return "sketchy"
    return "safe"


async def gelbooru_post_for_import(post_id: int, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """Return the exact file URL and source-provided tags for one Gelbooru post."""
    if post_id <= 0:
        raise ValueError("Invalid Gelbooru post ID")
    auth = _auth_params()
    payload = await _fetch_json(
        {
            "page": "dapi",
            "s": "post",
            "q": "index",
            "json": 1,
            "id": post_id,
            **auth,
        },
        timeout,
    )
    posts = _rows(payload, "post")
    if not posts:
        raise LookupError("Gelbooru post was not found")
    post = posts[0]
    file_url = str(post.get("file_url") or "").strip()
    if not file_url.startswith(("http://", "https://")):
        raise LookupError("Gelbooru did not return an original file URL")

    tags = list(dict.fromkeys(str(post.get("tags") or "").split()))
    categories = {tag: "general" for tag in tags}
    # Keep each request URL bounded; posts with hundreds of tags still receive
    # every tag even if category enrichment for a later chunk fails.
    for offset in range(0, len(tags), 80):
        chunk = tags[offset:offset + 80]
        if not chunk:
            continue
        try:
            tag_payload = await _fetch_json(
                {
                    "page": "dapi",
                    "s": "tag",
                    "q": "index",
                    "json": 1,
                    "limit": len(chunk),
                    "names": " ".join(chunk),
                    **auth,
                },
                timeout,
            )
        except RuntimeError:
            continue
        for row in _rows(tag_payload, "tag"):
            name = str(row.get("name") or row.get("tag") or "").strip()
            category = TAG_TYPE_TO_CATEGORY.get(int(row.get("type") or 0))
            if name in categories and category:
                categories[name] = category

    id_tag = f"gelbooru_{post_id}"
    if id_tag not in tags:
        tags.append(id_tag)
    categories[id_tag] = "meta"
    post_url = f"{GELBOORU}/index.php?page=post&s=view&id={post_id}"
    return {
        "kind": "gelbooru",
        "postId": post_id,
        "postUrl": post_url,
        "fileUrl": file_url,
        "referer": f"{GELBOORU}/",
        "tags": tags,
        "tagCategories": categories,
        "tagDisplayNames": {},
        "safety": _safety(post.get("rating")),
        "remoteSource": str(post.get("source") or "").strip() or None,
        "width": post.get("width"),
        "height": post.get("height"),
    }
