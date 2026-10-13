"""Loading, saving and validating AutoTagOptions, plus the stored HuggingFace and worker tokens."""
from __future__ import annotations

import os
from dataclasses import asdict

from ...config import settings
from ..settings import SettingsManager
from .core import AutoTagOptions, QWEN_SEMANTIC_MODEL_IDS
from .runtime import _normalize_torch_device
from .semantic import _clean_semantic_prompt


def default_options() -> AutoTagOptions:
    return AutoTagOptions(enabled=bool(settings.auto_tagger_enabled))


def load_options() -> AutoTagOptions:
    manager = SettingsManager(settings.config_file)
    raw = manager.get_auto_tag_settings()
    data = asdict(default_options())
    data.update({k: v for k, v in raw.items() if k in data})
    # Env opt-in remains a hard enable convenience for dev/test.
    if settings.auto_tagger_enabled:
        data["enabled"] = True
    if os.environ.get("NEKO_AI_WORKER"):
        data["remoteEnabled"] = False
        data["remoteUrl"] = ""
    return validate_options(data)


def save_options(raw: dict) -> AutoTagOptions:
    opts = validate_options(raw)
    SettingsManager(settings.config_file).set_auto_tag_settings(asdict(opts))
    return opts


def huggingface_token() -> str | None:
    """Return the configured Hugging Face token without exposing it in settings JSON."""
    return (
        SettingsManager(settings.config_file).get_huggingface_token()
        or os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    )


def save_huggingface_token(token: str) -> None:
    token = str(token or "").strip()
    if not token:
        raise ValueError("Hugging Face token cannot be empty")
    SettingsManager(settings.config_file).set_huggingface_token(token)


def delete_huggingface_token() -> None:
    SettingsManager(settings.config_file).delete_huggingface_token()


def tagger_worker_token() -> str | None:
    """Shared token for remote tagger-worker auth (config value or env)."""
    return (
        SettingsManager(settings.config_file).get_tagger_worker_token()
        or os.environ.get("NEKO_TAGGER_WORKER_TOKEN")
    )


def save_tagger_worker_token(token: str) -> None:
    token = str(token or "").strip()
    if not token:
        raise ValueError("Tagger worker token cannot be empty")
    SettingsManager(settings.config_file).set_tagger_worker_token(token)


def delete_tagger_worker_token() -> None:
    SettingsManager(settings.config_file).delete_tagger_worker_token()


def validate_options(raw: dict) -> AutoTagOptions:
    data = asdict(default_options())
    data.update({k: v for k, v in (raw or {}).items() if k in data})
    for key in ("generalThreshold", "characterThreshold", "unsafeThreshold", "sketchyThreshold"):
        data[key] = min(1.0, max(0.0, float(data[key])))
    data["maxTags"] = min(200, max(1, int(data["maxTags"])))
    data["videoMaxFrames"] = min(8, max(1, int(data["videoMaxFrames"])))
    try:
        frame_time = data.get("videoFrameTime")
        data["videoFrameTime"] = None if frame_time in (None, "") else max(0.0, float(frame_time))
    except (TypeError, ValueError):
        data["videoFrameTime"] = None
    data["qwenVideoUseFps"] = bool(data.get("qwenVideoUseFps"))
    data["qwenVideoMaxFrames"] = min(64, max(1, int(data["qwenVideoMaxFrames"])))
    data["videoMaxDurationSeconds"] = min(7200, max(1, int(data["videoMaxDurationSeconds"])))
    data["lightlyTaggedMaxTags"] = min(50, max(0, int(data["lightlyTaggedMaxTags"])))
    if data["mergeMode"] not in {"append_new", "replace_auto_tags", "preview_only"}:
        data["mergeMode"] = "append_new"
    if data["defaultBackfillMode"] not in {"untagged", "lightly_tagged", "all", "images", "videos", "selected"}:
        data["defaultBackfillMode"] = "lightly_tagged"
    data["torchDevice"] = _normalize_torch_device(data.get("torchDevice"))
    data["remoteEnabled"] = bool(data.get("remoteEnabled"))
    data["remoteUrl"] = str(data.get("remoteUrl") or "").strip().rstrip("/")
    data["remoteTimeoutSeconds"] = min(1800, max(5, int(data.get("remoteTimeoutSeconds") or 120)))
    data["semanticPrompt"] = _clean_semantic_prompt(data.get("semanticPrompt"))
    data["semanticModelId"] = str(data.get("semanticModelId") or "qwen").strip()
    if data["semanticModelId"] not in QWEN_SEMANTIC_MODEL_IDS:
        data["semanticModelId"] = "qwen"
    if not isinstance(data["excludedTags"], list):
        data["excludedTags"] = []
    if not isinstance(data["keywordRules"], list):
        data["keywordRules"] = []
    data["inheritSimilarMaxDistance"] = min(64, max(0, int(data.get("inheritSimilarMaxDistance") or 8)))
    data["inheritSimilarMinTags"] = min(50, max(0, int(data.get("inheritSimilarMinTags") or 1)))
    return AutoTagOptions(**data)


def _semantic_model_id(opts: AutoTagOptions) -> str:
    model_id = str(opts.semanticModelId or "qwen")
    return model_id if model_id in QWEN_SEMANTIC_MODEL_IDS else "qwen"
