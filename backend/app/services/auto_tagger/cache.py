"""HuggingFace cache lookup: where each model's files live and whether they are downloaded."""
from __future__ import annotations

import os
import logging
from importlib.util import find_spec
from pathlib import Path

from ...config import settings
from .core import MODEL_REGISTRY, QWEN_GGUF_MMPROJ_FILE
from .options import huggingface_token

logger = logging.getLogger(__package__)


def _qwen_gguf_dir(model_id: str) -> Path:
    return settings.models_dir / "gguf" / model_id


def _file_size(path: Path) -> int:
    try:
        return int(path.stat().st_size)
    except OSError:
        return 0


def _expected_download_total(model_id: str) -> int:
    meta = MODEL_REGISTRY.get(model_id) or {}
    expected = int(meta.get("expectedTotalBytes") or 0)
    if expected:
        return expected
    file_sizes = meta.get("fileSizes") or {}
    required = [str(name) for name in meta.get("requiredFiles") or []]
    return sum(int(file_sizes.get(filename) or 0) for filename in required)


def _local_file_download_progress(model_id: str) -> tuple[int, int]:
    meta = MODEL_REGISTRY.get(model_id) or {}
    if meta.get("storage") != "local_files":
        return 0, 0

    root = _qwen_gguf_dir(model_id)
    required = [str(name) for name in meta.get("requiredFiles") or []]
    file_sizes = meta.get("fileSizes") or {}
    total = _expected_download_total(model_id)
    downloaded = 0
    missing_expected = 0

    for filename in required:
        expected = int(file_sizes.get(filename) or 0)
        path = root / filename
        if path.exists():
            size = _file_size(path)
            downloaded += min(size, expected) if expected else size
        else:
            missing_expected += expected

    cache_download_dir = root / ".cache" / "huggingface" / "download"
    if missing_expected and cache_download_dir.exists():
        partial = 0
        try:
            for path in cache_download_dir.glob("*.incomplete"):
                partial += _file_size(path)
        except OSError:
            partial = 0
        downloaded += min(partial, missing_expected)

    return downloaded, total


def _qwen_gguf_paths(model_id: str) -> tuple[Path, Path]:
    meta = MODEL_REGISTRY[model_id]
    root = _qwen_gguf_dir(model_id)
    files = [str(name) for name in meta.get("requiredFiles") or []]
    model_file = next((name for name in files if not name.startswith("mmproj-")), "")
    if not model_file:
        raise RuntimeError(f"{meta['name']} is missing a configured GGUF model file")
    model_path = root / model_file
    mmproj_path = root / QWEN_GGUF_MMPROJ_FILE
    missing = [str(path) for path in (model_path, mmproj_path) if not path.exists()]
    if missing:
        raise RuntimeError(f"{meta['name']} is not downloaded: {', '.join(missing)}")
    return model_path, mmproj_path


def _repo_cache_path(repo_id: str) -> Path:
    return _hf_cache_dir() / f"models--{repo_id.replace('/', '--')}"


def _has_neko_models(hub_dir: Path) -> bool:
    """True if any NekoBooru tagger model is cached under this HF hub dir."""
    try:
        if not hub_dir.exists():
            return False
        for meta in MODEL_REGISTRY.values():
            repo = str(meta.get("repoId", ""))
            if repo and (hub_dir / f"models--{repo.replace('/', '--')}").exists():
                return True
    except OSError:
        return False
    return False


def _hf_cache_dir() -> Path:
    """Hugging Face hub cache NekoBooru reads, writes, and detects models in.

    Defaults to the app's models dir. Older NekoBooru versions downloaded to
    the default Hugging Face cache, so after an upgrade the app would otherwise
    look in a fresh empty location and report existing models as missing. To
    avoid orphaning them, fall back to the legacy default cache when the app dir
    has no NekoBooru models and the legacy one does.
    """
    primary = settings.models_dir / "huggingface" / "hub"
    if os.environ.get("NEKO_MODELS_DIR"):
        return primary
    legacy = Path.home() / ".cache" / "huggingface" / "hub"
    try:
        different = legacy.resolve() != primary.resolve()
    except OSError:
        different = True
    if different and not _has_neko_models(primary) and _has_neko_models(legacy):
        return legacy
    return primary


def _model_cache_paths(repo_id: str) -> list[Path]:
    hub_root = _hf_cache_dir().resolve()
    repo_cache = _repo_cache_path(repo_id).resolve()
    paths = [repo_cache]

    # File-level downloads can leave repo-specific blobs or incomplete files next
    # to the snapshot cache. Remove only files referenced by this repo cache.
    refs_root = repo_cache / "refs"
    blobs_root = repo_cache / "blobs"
    snapshots_root = repo_cache / "snapshots"
    for root in (refs_root, blobs_root, snapshots_root):
        if root.exists():
            paths.append(root.resolve())

    for path in list(paths):
        if path != hub_root and hub_root not in path.parents:
            raise RuntimeError("Resolved model cache path is outside the Hugging Face cache")

    seen = set()
    unique = []
    for path in paths:
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def model_cache_status(model_id: str = "wd") -> dict:
    meta = MODEL_REGISTRY.get(model_id)
    if not meta:
        raise ValueError(f"Unknown model: {model_id}")

    if meta.get("storage") == "local_files":
        root = _qwen_gguf_dir(model_id)
        files = {}
        for filename in [str(name) for name in meta.get("requiredFiles") or []]:
            path = root / filename
            files[filename] = {"downloaded": path.exists(), "path": str(path) if path.exists() else None}
        return {
            "downloaded": bool(files) and all(row["downloaded"] for row in files.values()),
            "files": files,
        }

    files = {}
    if find_spec("huggingface_hub") is None:
        return {
            "downloaded": False,
            "files": {},
        }

    from huggingface_hub import hf_hub_download  # type: ignore

    repo_id = str(meta["repoId"])
    patterns = meta.get("allowPatterns")
    required_files = [str(name) for name in meta.get("requiredFiles") or []]
    required_kinds = [str(name) for name in meta.get("requiredFileKinds") or []]
    snapshot_root = None
    if patterns:
        filenames = list(patterns)
    elif required_files:
        snapshot_root = _latest_snapshot_dir(repo_id)
        filenames = required_files
    else:
        snapshot_root = _latest_snapshot_dir(repo_id)
        filenames = _snapshot_file_names(snapshot_root) if snapshot_root else []

    for filename in filenames:
        try:
            if patterns:
                path = hf_hub_download(
                    repo_id,
                    filename,
                    token=huggingface_token(),
                    local_files_only=True,
                    cache_dir=_hf_cache_dir(),
                )
            else:
                if not snapshot_root:
                    raise FileNotFoundError(filename)
                path = str(snapshot_root / filename)
                if not Path(path).exists():
                    raise FileNotFoundError(path)
            files[filename] = {"downloaded": True, "path": path}
        except Exception:
            files[filename] = {"downloaded": False, "path": None}
    if required_files:
        downloaded = all(files.get(required, {}).get("downloaded") for required in required_files)
    elif required_kinds:
        downloaded = _files_satisfy_required_kinds(files, required_kinds)
    else:
        downloaded = bool(files) and all(meta["downloaded"] for meta in files.values())
    return {
        "downloaded": downloaded,
        "files": files,
    }


def _cache_name_matches(filename: str, required: str) -> bool:
    normalized = filename.replace("\\", "/")
    return normalized == required or normalized.endswith(f"/{required}")


def _files_satisfy_required_kinds(files: dict, required_kinds: list[str]) -> bool:
    downloaded_names = [
        str(name).lower()
        for name, meta in files.items()
        if isinstance(meta, dict) and meta.get("downloaded")
    ]
    for kind in required_kinds:
        if kind == "onnx" and not any(name.endswith(".onnx") for name in downloaded_names):
            return False
        if kind == "tags" and not any(
            name.endswith((".csv", ".json", ".txt")) and any(token in name for token in ("tag", "label", "class"))
            for name in downloaded_names
        ):
            return False
    return bool(downloaded_names)


def _snapshot_file_names(snapshot_root: Path) -> list[str]:
    names: list[str] = []
    try:
        iterator = snapshot_root.rglob("*")
        for path in iterator:
            try:
                if path.is_file():
                    names.append(str(path.relative_to(snapshot_root)).replace("\\", "/"))
            except OSError as exc:
                logger.debug("Skipping unreadable model cache path %s: %s", path, exc)
    except OSError as exc:
        logger.warning("Could not scan model cache snapshot %s: %s", snapshot_root, exc)
    return names


def _latest_snapshot_dir(repo_id: str) -> Path | None:
    repo_cache = _repo_cache_path(repo_id)
    snapshots = repo_cache / "snapshots"
    if not snapshots.exists():
        return None
    candidates = [path for path in snapshots.iterdir() if path.is_dir()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)
