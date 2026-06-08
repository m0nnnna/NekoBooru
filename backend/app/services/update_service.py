"""GitHub Release update checks for packaged NekoBooru installs."""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..config import settings
from .settings import SettingsManager

DEFAULT_OWNER = "m0nnnna"
DEFAULT_REPO = "NekoBooru"
VALID_CHANNELS = {"stable", "prerelease", "off"}

_last_check: dict | None = None


def _version_tuple(value: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", str(value or ""))
    return tuple(int(part) for part in parts[:4]) if parts else (0,)


def current_version() -> str:
    try:
        from importlib.metadata import version
        return version("nekobooru")
    except Exception:
        return "4.1.0"


def load_settings() -> dict:
    raw = SettingsManager(settings.config_file).get_update_settings()
    owner = str(raw.get("owner") or raw.get("githubOwner") or DEFAULT_OWNER).strip() or DEFAULT_OWNER
    repo = str(raw.get("repo") or raw.get("githubRepo") or DEFAULT_REPO).strip() or DEFAULT_REPO
    channel = str(raw.get("channel") or "stable").strip().lower()
    if channel not in VALID_CHANNELS:
        channel = "stable"
    return {
        "owner": owner,
        "repo": repo,
        "channel": channel,
        "autoCheck": bool(raw.get("autoCheck", True)),
        "autoDownload": bool(raw.get("autoDownload", False)),
        "includePrereleases": bool(raw.get("includePrereleases", channel == "prerelease")),
        "releasesApiUrl": f"https://api.github.com/repos/{owner}/{repo}/releases",
        "releasesPageUrl": f"https://github.com/{owner}/{repo}/releases",
        "lastCheckedAt": raw.get("lastCheckedAt"),
        "lastCheckError": raw.get("lastCheckError"),
    }


def save_settings(raw: dict) -> dict:
    owner = str(raw.get("owner") or DEFAULT_OWNER).strip() or DEFAULT_OWNER
    repo = str(raw.get("repo") or DEFAULT_REPO).strip() or DEFAULT_REPO
    channel = str(raw.get("channel") or "stable").strip().lower()
    if channel not in VALID_CHANNELS:
        channel = "stable"
    cleaned = {
        "owner": owner,
        "repo": repo,
        "channel": channel,
        "autoCheck": bool(raw.get("autoCheck", True)),
        "autoDownload": bool(raw.get("autoDownload", False)),
        "includePrereleases": bool(raw.get("includePrereleases", channel == "prerelease")),
        "releasesApiUrl": f"https://api.github.com/repos/{owner}/{repo}/releases",
        "releasesPageUrl": f"https://github.com/{owner}/{repo}/releases",
    }
    SettingsManager(settings.config_file).set_update_settings(cleaned)
    return status()


def _fetch_releases(cfg: dict) -> list[dict]:
    request = Request(
        cfg["releasesApiUrl"],
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "NekoBooru-update-checker",
        },
    )
    with urlopen(request, timeout=12) as response:
        body = response.read().decode("utf-8")
    data = json.loads(body)
    if not isinstance(data, list):
        raise RuntimeError("GitHub did not return a release list")
    return data


def _pick_release(releases: list[dict], cfg: dict) -> dict | None:
    include_prereleases = cfg["channel"] == "prerelease" or cfg["includePrereleases"]
    for release in releases:
        if release.get("draft"):
            continue
        if release.get("prerelease") and not include_prereleases:
            continue
        return release
    return None


def _compact_asset(asset: dict | None) -> dict | None:
    if not asset:
        return None
    return {
        "name": asset.get("name"),
        "size": asset.get("size"),
        "downloadUrl": asset.get("browser_download_url"),
    }


def _asset_summary(release: dict) -> dict:
    assets = release.get("assets") or []
    installer = next((a for a in assets if str(a.get("name", "")).lower().endswith(".exe") and "setup" in str(a.get("name", "")).lower()), None)
    checksums = next((a for a in assets if str(a.get("name", "")).lower() in {"sha256sums.txt", "sha256sum.txt"}), None)
    manifest = next((a for a in assets if str(a.get("name", "")).lower() == "release-manifest.json"), None)
    return {
        "count": len(assets),
        "windowsInstaller": _compact_asset(installer),
        "checksums": _compact_asset(checksums),
        "manifest": _compact_asset(manifest),
    }


def check_now() -> dict:
    global _last_check
    cfg = load_settings()
    now = datetime.now(timezone.utc).isoformat()
    if cfg["channel"] == "off":
        _last_check = {
            "checkedAt": now,
            "available": False,
            "message": "Update checks are disabled.",
        }
        return status()

    try:
        release = _pick_release(_fetch_releases(cfg), cfg)
        local = current_version()
        if not release:
            result = {
                "checkedAt": now,
                "available": False,
                "message": "No matching GitHub release was found.",
            }
        else:
            remote_version = str(release.get("tag_name") or release.get("name") or "").lstrip("v")
            available = _version_tuple(remote_version) > _version_tuple(local)
            result = {
                "checkedAt": now,
                "available": available,
                "currentVersion": local,
                "latestVersion": remote_version,
                "releaseName": release.get("name") or release.get("tag_name"),
                "tagName": release.get("tag_name"),
                "prerelease": bool(release.get("prerelease")),
                "publishedAt": release.get("published_at"),
                "htmlUrl": release.get("html_url"),
                "body": (release.get("body") or "")[:2000],
                "assets": _asset_summary(release),
                "message": "Update available." if available else "NekoBooru is up to date.",
            }
        _last_check = result
        saved = load_settings()
        saved["lastCheckedAt"] = now
        saved["lastCheckError"] = ""
        SettingsManager(settings.config_file).set_update_settings(saved)
    except (HTTPError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        _last_check = {
            "checkedAt": now,
            "available": False,
            "error": str(exc),
            "message": f"Update check failed: {exc}",
        }
        saved = load_settings()
        saved["lastCheckedAt"] = now
        saved["lastCheckError"] = str(exc)
        SettingsManager(settings.config_file).set_update_settings(saved)
    return status()


def status(auto_check: bool = False) -> dict:
    cfg = load_settings()
    if auto_check and cfg["autoCheck"] and cfg["channel"] != "off":
        last_at = cfg.get("lastCheckedAt")
        should_check = True
        if last_at:
            try:
                parsed = datetime.fromisoformat(str(last_at).replace("Z", "+00:00"))
                should_check = (time.time() - parsed.timestamp()) > 60 * 60 * 12
            except ValueError:
                should_check = True
        if should_check:
            return check_now()
    return {
        "settings": cfg,
        "currentVersion": current_version(),
        "lastCheck": _last_check,
    }
