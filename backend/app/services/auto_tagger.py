"""Optional local image/video auto-tagging for NekoBooru."""
from __future__ import annotations

import csv
import os
import json
import logging
import math
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import gc
from dataclasses import asdict, dataclass, field
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from PIL import Image

from ..config import settings
from .media import check_ffmpeg_available
from .settings import SettingsManager

logger = logging.getLogger(__name__)

SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
SUPPORTED_VIDEO_EXTS = {".webm", ".mp4"}
WD_MODEL_ID = "SmilingWolf/wd-eva02-large-tagger-v3"
WHISPER_MAX_AUDIO_SECONDS = 30
QWEN_MIN_FREE_VRAM_GB = 18.0
MEDIA_TYPE_TAGS = {
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".webp": "image",
    ".gif": "gif",
    ".mp4": "video",
    ".webm": "video",
}
DEFAULT_NOISY_TAGS = {
    "absurdres",
    "best_quality",
    "card_medium",
    "commentary_request",
    "compression_artifacts",
    "high_quality",
    "highres",
    "jpeg_artifacts",
    "low_quality",
    "lowres",
    "medium_quality",
    "outline",
    "signature",
    "text_focus",
    "thumbnail",
    "transparent_background",
    "twitter_username",
    "username",
    "watermark",
    "worst_quality",
}

MODEL_REGISTRY = {
    "wd": {
        "id": "wd",
        "name": "WD Tagger",
        "repoId": WD_MODEL_ID,
        "purpose": "Booru-style image and sampled video-frame tags",
        "downloadSize": "~1.2 GB",
        "vramRequirement": "~0.5-1.5 GB",
        "status": "tagging_ready",
        "allowPatterns": ["model.onnx", "selected_tags.csv"],
    },
    "camie": {
        "id": "camie",
        "name": "Camie Tagger v2",
        "repoId": "Camais03/camie-tagger-v2",
        "purpose": "Anime character, copyright, artist, rating, and broad tag coverage",
        "downloadSize": "~1-3 GB",
        "vramRequirement": "~0.5-2 GB",
        "status": "tagging_ready",
        "allowPatterns": None,
    },
    "qwen": {
        "id": "qwen",
        "name": "Qwen2.5-VL 7B Instruct",
        "repoId": "Qwen/Qwen2.5-VL-7B-Instruct",
        "purpose": "Semantic video/edit understanding, political context, and natural-language evidence",
        "downloadSize": "~15-17 GB",
        "vramRequirement": "~14-18 GB fp16, 24 GB comfortable",
        "status": "tagging_ready",
        "allowPatterns": None,
    },
    "ocr": {
        "id": "ocr",
        "name": "TrOCR Printed",
        "repoId": "microsoft/trocr-base-printed",
        "purpose": "Text extraction from meme/edit frames and subtitles",
        "downloadSize": "~1.3 GB",
        "vramRequirement": "~1-2 GB",
        "status": "tagging_ready",
        "allowPatterns": None,
    },
    "whisper": {
        "id": "whisper",
        "name": "Whisper Small",
        "repoId": "openai/whisper-small",
        "purpose": "Speech/audio transcript signals for AMVs and edits",
        "downloadSize": "~1 GB",
        "vramRequirement": "~1-2 GB",
        "status": "tagging_ready",
        "allowPatterns": None,
    },
}

_download_lock = threading.Lock()
_download_job: dict[str, Any] | None = None
_load_lock = threading.Lock()
_load_job: dict[str, Any] | None = None

DEFAULT_SEMANTIC_PROMPT = (
    "Return compact JSON only with keys tags, safety, rationale. "
    "Use snake_case tags. Look for higher-level context such as political_edit, meme_edit, amv, music_video, "
    "captioned, protest, politician, propaganda, and contextual edit signals only when visually or transcript supported. "
    "Use national_socialism only for clear Nazi/far-right symbols such as a swastika, sonnenrad, or black_sun. "
    "Use communism only for clear communist symbols such as a hammer_and_sickle or communist red star. "
    "If transcript or audio evidence suggests a song or music-driven edit, include music and edit."
)


@dataclass
class AutoTagOptions:
    enabled: bool = False
    tagNewUploads: bool = False
    tagNewImports: bool = False
    tagImages: bool = True
    tagVideos: bool = True
    wdEnabled: bool = True
    generalThreshold: float = 0.35
    characterThreshold: float = 0.45
    maxTags: int = 40
    addProvenanceTag: bool = True
    provenanceTag: str = "auto_tagged"
    applySafety: bool = True
    unsafeThreshold: float = 0.70
    sketchyThreshold: float = 0.65
    neverDowngradeSafety: bool = True
    defaultBackfillMode: str = "lightly_tagged"
    lightlyTaggedMaxTags: int = 2
    mergeMode: str = "append_new"
    previewByDefault: bool = True
    videoFrameStrategy: str = "multi"
    videoMaxFrames: int = 4
    videoMaxDurationSeconds: int = 900
    semanticPoliticalEnabled: bool = False
    semanticPrompt: str = DEFAULT_SEMANTIC_PROMPT
    ocrEnabled: bool = False
    whisperEnabled: bool = False
    qwenEnabled: bool = False
    characterModelEnabled: bool = False
    torchDevice: str = "auto"
    # Offload inference to a remote GPU worker (another NekoBooru instance with
    # the AI stack installed). When enabled, tag_media() forwards media to the
    # worker's /api/auto-tags/infer instead of running models in this process.
    remoteEnabled: bool = False
    remoteUrl: str = ""
    remoteTimeoutSeconds: int = 120
    excludedTags: list[str] = field(default_factory=list)
    keywordRules: list[dict] = field(default_factory=list)


@dataclass
class AutoTagResult:
    tags: list[str] = field(default_factory=list)
    character_tags: list[str] = field(default_factory=list)
    copyright_tags: list[str] = field(default_factory=list)
    rating: dict[str, float] = field(default_factory=dict)
    safety: str | None = None
    categories: dict[str, str] = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)
    model: str = ""
    enabled: bool = False
    error: str | None = None

    @property
    def all_tags(self) -> list[str]:
        raw = [*self.tags, *self.character_tags, *self.copyright_tags]
        seen: set[str] = set()
        out: list[str] = []
        for tag in raw:
            norm = normalize_tag(tag)
            if norm and norm not in seen:
                seen.add(norm)
                out.append(norm)
        return out


class WdTagger:
    name = "wd-eva02-large-tagger-v3"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._session = None
        self._tag_rows: list[tuple[str, int]] = []
        self._providers: list[str] = []

    def is_loaded(self) -> bool:
        return self._loaded

    def unload(self) -> bool:
        with self._lock:
            was_loaded = self._loaded
            self._session = None
            self._tag_rows = []
            self._providers = []
            self._loaded = False
            gc.collect()
            return was_loaded

    def ensure_loaded(self, progress=None) -> bool:
        with self._lock:
            if self._loaded:
                if progress:
                    progress("ready", 100, "Model weights already loaded")
                return True
            self._load(progress=progress)
            self._loaded = True
            if progress:
                progress("ready", 100, "Model weights loaded")
            return True

    def _load(self, progress=None) -> None:
        from huggingface_hub import hf_hub_download  # type: ignore
        import onnxruntime as ort  # type: ignore

        token = huggingface_token()
        if progress:
            progress("resolve_files", 8, "Resolving cached model files")
        model_path = hf_hub_download(WD_MODEL_ID, "model.onnx", token=token)
        if progress:
            progress("resolve_tags", 22, "Resolving tag metadata")
        tags_path = hf_hub_download(WD_MODEL_ID, "selected_tags.csv", token=token)
        if progress:
            progress("load_weights", 35, "Loading ONNX weights into memory")
        self._session = ort.InferenceSession(
            model_path,
            providers=_onnx_providers(ort),
        )
        self._providers = list(self._session.get_providers())
        if progress:
            progress("read_tags", 85, "Reading tag metadata")
        rows: list[tuple[str, int]] = []
        with open(tags_path, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                rows.append((str(row["name"]), int(row["category"])))
        self._tag_rows = rows

    def tag_image(self, path: Path, opts: AutoTagOptions) -> AutoTagResult:
        self.ensure_loaded()
        import numpy as np  # type: ignore

        with Image.open(path) as image:
            image = image.convert("RGB")
            image = _letterbox(image, 448)
            arr = np.asarray(image, dtype=np.float32)[None, ...]

        input_name = self._session.get_inputs()[0].name
        scores = self._session.run(None, {input_name: arr})[0][0]

        general: list[tuple[str, float]] = []
        characters: list[tuple[str, float]] = []
        rating: dict[str, float] = {}

        for (name, category), score in zip(self._tag_rows, scores):
            confidence = float(score)
            norm = normalize_tag(name)
            if category == 0 and confidence >= opts.generalThreshold:
                general.append((norm, confidence))
            elif category == 4 and confidence >= opts.characterThreshold:
                characters.append((norm, confidence))
            elif category == 9:
                rating[norm] = confidence

        general.sort(key=lambda item: item[1], reverse=True)
        characters.sort(key=lambda item: item[1], reverse=True)

        max_tags = max(1, int(opts.maxTags))
        tags = [name for name, _ in general[:max_tags]]
        character_tags = [name for name, _ in characters[:max_tags]]
        safety = safety_from_rating(rating, opts)
        categories = {tag: "character" for tag in character_tags}
        categories.update({tag: "general" for tag in tags})

        return AutoTagResult(
            tags=tags,
            character_tags=character_tags,
            rating=rating,
            safety=safety,
            categories=categories,
            evidence={
                "kind": "image",
                "topTags": [{"tag": n, "confidence": c} for n, c in general[:10]],
                "topCharacters": [{"tag": n, "confidence": c} for n, c in characters[:10]],
                "rating": rating,
            },
            model=self.name,
            enabled=True,
        )


class CamieTagger:
    name = "camie-tagger-v2"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._session = None
        self._idx_to_tag: dict[str, str] = {}
        self._tag_to_category: dict[str, str] = {}
        self._image_size = 512
        self._providers: list[str] = []

    def is_loaded(self) -> bool:
        return self._loaded

    def unload(self) -> bool:
        with self._lock:
            was_loaded = self._loaded
            self._session = None
            self._idx_to_tag = {}
            self._tag_to_category = {}
            self._providers = []
            self._loaded = False
            gc.collect()
            return was_loaded

    def ensure_loaded(self) -> bool:
        with self._lock:
            if self._loaded:
                return True
            self._load()
            self._loaded = True
            return True

    def _load(self) -> None:
        import onnxruntime as ort  # type: ignore

        cache = model_cache_status("camie")
        files = cache.get("files") or {}
        model_path = _cached_file(files, "camie-tagger-v2.onnx")
        metadata_path = _cached_file(files, "camie-tagger-v2-metadata.json")
        if not model_path or not metadata_path:
            raise RuntimeError("Camie model files are not downloaded")

        with open(metadata_path, encoding="utf-8") as fh:
            metadata = json.load(fh)
        info = metadata.get("model_info") or {}
        mapping = ((metadata.get("dataset_info") or {}).get("tag_mapping") or {})
        self._image_size = int(info.get("img_size") or 512)
        self._idx_to_tag = {str(k): str(v) for k, v in (mapping.get("idx_to_tag") or {}).items()}
        self._tag_to_category = {str(k): str(v) for k, v in (mapping.get("tag_to_category") or {}).items()}
        self._session = ort.InferenceSession(model_path, providers=_onnx_providers(ort))
        self._providers = list(self._session.get_providers())

    def tag_image(self, path: Path, opts: AutoTagOptions) -> AutoTagResult:
        self.ensure_loaded()
        import numpy as np  # type: ignore

        arr = _imagenet_tensor(path, self._image_size)
        input_name = self._session.get_inputs()[0].name
        outputs = self._session.run(None, {input_name: arr})
        logits = outputs[1] if len(outputs) >= 2 else outputs[0]
        probs = 1.0 / (1.0 + np.exp(-logits[0]))

        by_category: dict[str, list[tuple[str, float]]] = {
            "general": [],
            "character": [],
            "copyright": [],
            "artist": [],
            "rating": [],
            "meta": [],
        }
        threshold_by_category = {
            "character": opts.characterThreshold,
            "copyright": opts.characterThreshold,
            "artist": opts.characterThreshold,
            "general": opts.generalThreshold,
            "meta": opts.generalThreshold,
            "rating": 0.05,
        }
        for idx, score in enumerate(probs):
            tag = self._idx_to_tag.get(str(idx))
            if not tag:
                continue
            category = self._tag_to_category.get(tag, "general")
            confidence = float(score)
            if confidence >= threshold_by_category.get(category, opts.generalThreshold):
                by_category.setdefault(category, []).append((normalize_tag(tag), confidence))

        for category in by_category:
            by_category[category].sort(key=lambda item: item[1], reverse=True)

        max_tags = max(1, int(opts.maxTags))
        rating = {
            tag.replace("rating_", ""): score
            for tag, score in by_category.get("rating", [])[:8]
        }
        safety = _camie_safety(rating, opts)
        tags = [tag for tag, _ in by_category.get("general", [])[:max_tags]]
        character_tags = [tag for tag, _ in by_category.get("character", [])[:max_tags]]
        copyright_tags = [tag for tag, _ in by_category.get("copyright", [])[:max_tags]]
        categories = {tag: "general" for tag in tags}
        categories.update({tag: "character" for tag in character_tags})
        categories.update({tag: "copyright" for tag in copyright_tags})
        categories.update({tag: "artist" for tag, _ in by_category.get("artist", [])[:max_tags]})

        return AutoTagResult(
            tags=tags,
            character_tags=character_tags,
            copyright_tags=copyright_tags,
            rating=rating,
            safety=safety,
            categories=categories,
            evidence={
                "kind": "camie",
                "topTags": [{"tag": n, "confidence": c} for n, c in by_category.get("general", [])[:10]],
                "topCharacters": [{"tag": n, "confidence": c} for n, c in by_category.get("character", [])[:10]],
                "topCopyrights": [{"tag": n, "confidence": c} for n, c in by_category.get("copyright", [])[:10]],
                "rating": rating,
            },
            model=self.name,
            enabled=True,
        )


class OcrTagger:
    name = "trocr-base-printed"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._processor = None
        self._model = None

    def is_loaded(self) -> bool:
        return self._loaded

    def unload(self) -> bool:
        with self._lock:
            was_loaded = self._loaded
            self._processor = None
            self._model = None
            self._loaded = False
            _clear_torch_cache()
            return was_loaded

    def ensure_loaded(self) -> bool:
        with self._lock:
            if self._loaded:
                return True
            from transformers import TrOCRProcessor, VisionEncoderDecoderModel  # type: ignore

            repo_id = MODEL_REGISTRY["ocr"]["repoId"]
            self._processor = TrOCRProcessor.from_pretrained(repo_id, token=huggingface_token())
            self._model = VisionEncoderDecoderModel.from_pretrained(repo_id, token=huggingface_token())
            self._loaded = True
            return True

    def read_image(self, path: Path) -> AutoTagResult:
        self.ensure_loaded()
        with Image.open(path) as image:
            image = image.convert("RGB")
            pixel_values = self._processor(images=image, return_tensors="pt").pixel_values
        generated_ids = self._model.generate(pixel_values, max_new_tokens=96)
        text = self._processor.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()
        tags = []
        if _meaningful_ocr_text(text):
            tags.extend(["has_text", "text_overlay"])
        if _looks_political(text):
            tags.append("political_text")
        return AutoTagResult(
            tags=tags,
            categories={tag: "general" for tag in tags},
            evidence={"kind": "ocr", "text": text},
            model=self.name,
            enabled=True,
        )


class WhisperTagger:
    name = "whisper-small"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._pipeline = None

    def is_loaded(self) -> bool:
        return self._loaded

    def unload(self) -> bool:
        with self._lock:
            was_loaded = self._loaded
            self._pipeline = None
            self._loaded = False
            _clear_torch_cache()
            return was_loaded

    def ensure_loaded(self) -> bool:
        with self._lock:
            if self._loaded:
                return True
            from transformers import pipeline  # type: ignore

            self._pipeline = pipeline(
                "automatic-speech-recognition",
                model=MODEL_REGISTRY["whisper"]["repoId"],
                token=huggingface_token(),
            )
            self._loaded = True
            return True

    def transcribe_video(self, path: Path, opts: AutoTagOptions) -> AutoTagResult:
        self.ensure_loaded()
        cache_root = settings.cache_dir / "auto-tags"
        cache_root.mkdir(parents=True, exist_ok=True)
        wav_path = cache_root / f"audio-{uuid.uuid4()}.wav"
        try:
            audio_seconds = _whisper_audio_seconds(opts)
            if not _extract_audio(path, wav_path, audio_seconds):
                return AutoTagResult(enabled=True, model=self.name, error="audio_extract_failed")
            result = self._pipeline(str(wav_path), return_timestamps=False)
            text = str(result.get("text") if isinstance(result, dict) else result).strip()
        finally:
            wav_path.unlink(missing_ok=True)
        tags = _whisper_tags_from_text(text)
        return AutoTagResult(
            tags=tags,
            categories={tag: "general" for tag in tags},
            evidence={"kind": "whisper", "transcript": text},
            model=self.name,
            enabled=True,
        )


class QwenSemanticTagger:
    name = "qwen2.5-vl-7b-instruct"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._processor = None
        self._model = None
        self._device_preference = None

    def is_loaded(self) -> bool:
        return self._loaded

    def unload(self) -> bool:
        with self._lock:
            was_loaded = self._loaded
            self._processor = None
            self._model = None
            self._loaded = False
            self._device_preference = None
            _clear_torch_cache()
            return was_loaded

    def ensure_loaded(self, device_preference: str = "auto") -> bool:
        with self._lock:
            device_preference = _normalize_torch_device(device_preference)
            if self._loaded and self._device_preference == device_preference:
                return True
            if self._loaded:
                self._processor = None
                self._model = None
                self._loaded = False
                self._device_preference = None
                _clear_torch_cache()
            import torch  # type: ignore
            from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration  # type: ignore

            repo_id = MODEL_REGISTRY["qwen"]["repoId"]
            device_map = _qwen_device_map(device_preference)
            torch_dtype = torch.float16 if device_map != "cpu" and torch.cuda.is_available() else "auto"
            self._processor = AutoProcessor.from_pretrained(repo_id, token=huggingface_token())
            self._model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                repo_id,
                token=huggingface_token(),
                device_map=device_map,
                torch_dtype=torch_dtype,
                low_cpu_mem_usage=True,
            )
            self._loaded = True
            self._device_preference = device_preference
            return True

    def analyze_image(self, path: Path, context: dict | None = None, opts: AutoTagOptions | None = None) -> AutoTagResult:
        opts = opts or load_options()
        self.ensure_loaded(opts.torchDevice)
        from qwen_vl_utils import process_vision_info  # type: ignore

        prompt = _semantic_prompt(opts)
        if context:
            prompt += f" Context: {json.dumps(context)[:1000]}"
        messages = [{
            "role": "user",
            "content": [
                {"type": "image", "image": str(path)},
                {"type": "text", "text": prompt},
            ],
        }]
        text = self._processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        image_inputs, video_inputs = process_vision_info(messages)
        inputs = self._processor(text=[text], images=image_inputs, videos=video_inputs, padding=True, return_tensors="pt")
        inputs = inputs.to(self._model.device)
        generated_ids = self._model.generate(**inputs, max_new_tokens=160)
        trimmed = [out[len(inp):] for inp, out in zip(inputs.input_ids, generated_ids)]
        output = self._processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
        parsed = _parse_semantic_json(output)
        tags = [normalize_tag(tag) for tag in parsed.get("tags", []) if normalize_tag(tag)]
        safety = parsed.get("safety") if parsed.get("safety") in {"safe", "sketchy", "unsafe"} else None
        return AutoTagResult(
            tags=tags[:20],
            safety=safety,
            categories={tag: "general" for tag in tags[:20]},
            evidence={"kind": "qwen", "raw": output, "parsed": parsed},
            model=self.name,
            enabled=True,
        )

    def device_info(self) -> dict:
        info = {
            "preference": self._device_preference,
            "loaded": self._loaded,
            "device": None,
            "deviceMap": None,
        }
        if not self._model:
            return info
        try:
            info["device"] = str(getattr(self._model, "device", None))
        except Exception:
            pass
        try:
            device_map = getattr(self._model, "hf_device_map", None)
            if device_map:
                info["deviceMap"] = {str(k): str(v) for k, v in device_map.items()}
        except Exception:
            pass
        return info


_camie_tagger = CamieTagger()
_ocr_tagger = OcrTagger()
_whisper_tagger = WhisperTagger()
_qwen_tagger = QwenSemanticTagger()
_wd_tagger = WdTagger()


def _clear_torch_cache() -> None:
    gc.collect()
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def _normalize_torch_device(value: str | None) -> str:
    value = str(value or "auto").lower().strip()
    if value not in {"auto", "gpu", "cpu"}:
        return "auto"
    return value


def _torch_runtime_info() -> dict:
    info = {
        "available": find_spec("torch") is not None,
        "version": None,
        "cudaAvailable": False,
        "cudaVersion": None,
        "deviceCount": 0,
        "devices": [],
    }
    if not info["available"]:
        return info
    try:
        import torch  # type: ignore

        info["version"] = str(getattr(torch, "__version__", "unknown"))
        info["cudaAvailable"] = bool(torch.cuda.is_available())
        info["cudaVersion"] = str(getattr(torch.version, "cuda", None))
        info["deviceCount"] = int(torch.cuda.device_count()) if info["cudaAvailable"] else 0
        devices = []
        for idx in range(int(info["deviceCount"])):
            props = torch.cuda.get_device_properties(idx)
            devices.append({
                "index": idx,
                "name": torch.cuda.get_device_name(idx),
                "totalMemoryGb": round(float(props.total_memory) / 1024**3, 2),
                "allocatedGb": round(float(torch.cuda.memory_allocated(idx)) / 1024**3, 2),
                "reservedGb": round(float(torch.cuda.memory_reserved(idx)) / 1024**3, 2),
            })
        info["devices"] = devices
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    return info


def _onnx_runtime_info() -> dict:
    info = {
        "available": find_spec("onnxruntime") is not None,
        "availableProviders": [],
        "preferredProviders": [],
        "wdProviders": list(_wd_tagger._providers),
        "camieProviders": list(_camie_tagger._providers),
    }
    if not info["available"]:
        return info
    try:
        import onnxruntime as ort  # type: ignore

        info["availableProviders"] = list(ort.get_available_providers())
        info["preferredProviders"] = _onnx_providers(ort)
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    return info


def _onnx_providers(ort) -> list[str]:
    available = set(ort.get_available_providers())
    providers = []
    if "CUDAExecutionProvider" in available:
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")
    return providers


def _qwen_device_map(device_preference: str):
    device_preference = _normalize_torch_device(device_preference)
    torch_info = _torch_runtime_info()
    if device_preference == "gpu":
        if not torch_info.get("cudaAvailable"):
            raise RuntimeError("GPU was selected, but this Python environment has CPU-only torch or CUDA is unavailable.")
        _ensure_qwen_gpu_headroom()
        return {"": 0}
    if device_preference == "cpu":
        return "cpu"
    if torch_info.get("cudaAvailable"):
        _ensure_qwen_gpu_headroom()
        return {"": 0}
    return "cpu"


def _ensure_qwen_gpu_headroom() -> None:
    info = _qwen_gpu_memory_info()
    free_gb = float(info.get("freeGb") or 0.0)
    if free_gb < QWEN_MIN_FREE_VRAM_GB:
        raise RuntimeError(
            f"Qwen needs about {QWEN_MIN_FREE_VRAM_GB:g} GB free VRAM to load safely; "
            f"only {free_gb:.1f} GB is free. Unload other AI models or use Custom without Qwen."
        )


def _qwen_gpu_memory_info() -> dict:
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return {"available": False, "freeGb": 0.0, "totalGb": 0.0}
        free, total = torch.cuda.mem_get_info(0)
        return {
            "available": True,
            "freeGb": round(float(free) / 1024**3, 2),
            "totalGb": round(float(total) / 1024**3, 2),
        }
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "freeGb": 0.0, "totalGb": 0.0, "error": str(exc)}


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


def _clean_semantic_prompt(value: Any) -> str:
    prompt = str(value or "").strip()
    if not prompt:
        return DEFAULT_SEMANTIC_PROMPT
    return prompt[:4000]


def _semantic_prompt(opts: AutoTagOptions) -> str:
    return _clean_semantic_prompt(opts.semanticPrompt)


def validate_options(raw: dict) -> AutoTagOptions:
    data = asdict(default_options())
    data.update({k: v for k, v in (raw or {}).items() if k in data})
    for key in ("generalThreshold", "characterThreshold", "unsafeThreshold", "sketchyThreshold"):
        data[key] = min(1.0, max(0.0, float(data[key])))
    data["maxTags"] = min(200, max(1, int(data["maxTags"])))
    data["videoMaxFrames"] = min(8, max(1, int(data["videoMaxFrames"])))
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
    if not isinstance(data["excludedTags"], list):
        data["excludedTags"] = []
    if not isinstance(data["keywordRules"], list):
        data["keywordRules"] = []
    return AutoTagOptions(**data)


def _remote_worker_status(opts: AutoTagOptions) -> dict:
    """Report remote-worker config and live reachability (used by the UI)."""
    info = {
        "enabled": bool(opts.remoteEnabled),
        "url": opts.remoteUrl,
        "tokenConfigured": bool(tagger_worker_token()),
        "reachable": False,
        "worker": None,
        "error": None,
    }
    if not (opts.remoteEnabled and opts.remoteUrl):
        return info
    import httpx  # base dependency

    try:
        headers = {}
        token = tagger_worker_token()
        if token:
            headers["X-Tagger-Token"] = token
        response = httpx.get(
            f"{opts.remoteUrl.rstrip('/')}/api/auto-tags/status",
            headers=headers,
            timeout=5.0,
        )
        if response.status_code == 200:
            worker = response.json()
            info["reachable"] = True
            info["worker"] = {
                "torch": worker.get("torch"),
                "onnx": worker.get("onnx"),
                "torchDevice": worker.get("torchDevice"),
                "models": worker.get("models"),
                "ffmpeg": worker.get("ffmpeg"),
            }
        else:
            info["error"] = f"worker_error_{response.status_code}"
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"worker_unreachable: {exc}"
    return info


def status() -> dict:
    model_cache = model_cache_status()
    opts = load_options()
    return {
        "enabled": opts.enabled,
        "model": _wd_tagger.name,
        "modelId": WD_MODEL_ID,
        "modelLoaded": _wd_tagger.is_loaded(),
        "modelDownloaded": model_cache["downloaded"],
        "modelFiles": model_cache["files"],
        "models": model_statuses(),
        "downloadJob": current_download_job(),
        "loadJob": current_model_load_job(),
        "torch": _torch_runtime_info(),
        "onnx": _onnx_runtime_info(),
        "torchDevice": opts.torchDevice,
        "qwenDevice": _qwen_tagger.device_info(),
        "remote": _remote_worker_status(opts),
        "huggingFaceTokenConfigured": bool(huggingface_token()),
        "dependencies": {
            "huggingface_hub": find_spec("huggingface_hub") is not None,
            "onnxruntime": find_spec("onnxruntime") is not None,
            "numpy": find_spec("numpy") is not None,
            "pillow": find_spec("PIL") is not None,
            "transformers": find_spec("transformers") is not None,
            "torch": find_spec("torch") is not None,
            "qwen_vl_utils": find_spec("qwen_vl_utils") is not None,
        },
        "ffmpeg": check_ffmpeg_available(),
        "supportedImages": sorted(SUPPORTED_IMAGE_EXTS),
        "supportedVideos": sorted(SUPPORTED_VIDEO_EXTS),
        "characterModel": {
            "enabled": opts.characterModelEnabled,
            "model": "Camie Tagger v2",
            "available": model_cache_status("camie")["downloaded"] and find_spec("onnxruntime") is not None,
        },
    }


def current_model_load_job() -> dict | None:
    with _load_lock:
        return json.loads(json.dumps(_load_job)) if _load_job else None


def _tagger_for_model(model_id: str):
    if model_id == "wd":
        return _wd_tagger
    if model_id == "camie":
        return _camie_tagger
    if model_id == "ocr":
        return _ocr_tagger
    if model_id == "whisper":
        return _whisper_tagger
    if model_id == "qwen":
        return _qwen_tagger
    raise ValueError(f"Unknown model: {model_id}")


def start_model_load(model_id: str = "wd") -> dict:
    tagger = _tagger_for_model(model_id)

    global _load_job
    with _load_lock:
        if tagger.is_loaded():
            _load_job = _new_load_job(model_id, status="completed", progress=100, message="Model weights already loaded")
            return json.loads(json.dumps(_load_job))
        if _load_job and _load_job.get("status") in {"queued", "running"}:
            return json.loads(json.dumps(_load_job))
        _load_job = _new_load_job(model_id, status="queued", progress=0, message="Queued model weight load")
        job_id = _load_job["id"]
        snapshot = json.loads(json.dumps(_load_job))

    thread = threading.Thread(target=_run_model_load_job, args=(job_id, model_id), daemon=True)
    thread.start()
    return snapshot


def unload_model(model_id: str) -> dict:
    tagger = _tagger_for_model(model_id)
    was_loaded = bool(tagger.unload())
    return {
        "modelId": model_id,
        "model": MODEL_REGISTRY[model_id]["name"],
        "unloaded": was_loaded,
        "loaded": bool(tagger.is_loaded()),
        "models": model_statuses(),
    }


def _new_load_job(model_id: str, *, status: str, progress: int, message: str) -> dict:
    now = time.time()
    estimates = {
        "wd": 20,
        "camie": 30,
        "ocr": 25,
        "whisper": 25,
        "qwen": 90,
    }
    return {
        "id": str(uuid.uuid4()),
        "modelId": model_id,
        "model": MODEL_REGISTRY[model_id]["name"],
        "repoId": MODEL_REGISTRY[model_id]["repoId"],
        "status": status,
        "stage": status,
        "progress": progress,
        "message": message,
        "estimatedSeconds": estimates.get(model_id, 30),
        "startedAt": now,
        "updatedAt": now,
        "finishedAt": now if status in {"completed", "failed"} else None,
        "error": None,
    }


def _run_model_load_job(job_id: str, model_id: str) -> None:
    def progress(stage: str, percent: int, message: str) -> None:
        with _load_lock:
            if not _load_job or _load_job.get("id") != job_id:
                return
            _load_job["status"] = "running"
            _load_job["stage"] = stage
            _load_job["progress"] = max(0, min(100, int(percent)))
            _load_job["message"] = message
            _load_job["updatedAt"] = time.time()

    global _load_job
    try:
        progress("start", 3, "Preparing model runtime")
        if model_id == "wd":
            _wd_tagger.ensure_loaded(progress=progress)
        else:
            progress("load_weights", 15, f"Loading {MODEL_REGISTRY[model_id]['name']} weights into memory")
            if model_id == "qwen":
                _qwen_tagger.ensure_loaded(load_options().torchDevice)
            else:
                _tagger_for_model(model_id).ensure_loaded()
            progress("ready", 100, "Model weights loaded")
        with _load_lock:
            if _load_job and _load_job.get("id") == job_id:
                _load_job["status"] = "completed"
                _load_job["stage"] = "ready"
                _load_job["progress"] = 100
                _load_job["message"] = "Model weights loaded"
                _load_job["finishedAt"] = time.time()
                _load_job["updatedAt"] = time.time()
    except Exception as exc:  # noqa: BLE001
        logger.warning("model load failed for %s: %s", model_id, exc)
        with _load_lock:
            if _load_job and _load_job.get("id") == job_id:
                _load_job["status"] = "failed"
                _load_job["stage"] = "failed"
                _load_job["message"] = "Model load failed"
                _load_job["error"] = str(exc)
                _load_job["finishedAt"] = time.time()
                _load_job["updatedAt"] = time.time()


def model_cache_status(model_id: str = "wd") -> dict:
    meta = MODEL_REGISTRY.get(model_id)
    if not meta:
        raise ValueError(f"Unknown model: {model_id}")

    files = {}
    if find_spec("huggingface_hub") is None:
        return {
            "downloaded": False,
            "files": {},
        }

    from huggingface_hub import hf_hub_download, snapshot_download  # type: ignore

    repo_id = str(meta["repoId"])
    patterns = meta.get("allowPatterns")
    if patterns:
        filenames = list(patterns)
    else:
        snapshot_root = _latest_snapshot_dir(repo_id)
        filenames = [
            str(path.relative_to(snapshot_root)).replace("\\", "/")
            for path in snapshot_root.rglob("*")
            if path.is_file()
        ] if snapshot_root else []

    for filename in filenames:
        try:
            if patterns:
                path = hf_hub_download(
                    repo_id,
                    filename,
                    token=huggingface_token(),
                    local_files_only=True,
                )
            else:
                root = snapshot_download(
                    repo_id,
                    token=huggingface_token(),
                    local_files_only=True,
                    allow_patterns=None,
                )
                path = str(Path(root) / filename)
                if not Path(path).exists():
                    raise FileNotFoundError(path)
            files[filename] = {"downloaded": True, "path": path}
        except Exception:
            files[filename] = {"downloaded": False, "path": None}
    return {
        "downloaded": bool(files) and all(meta["downloaded"] for meta in files.values()),
        "files": files,
    }


def _latest_snapshot_dir(repo_id: str) -> Path | None:
    repo_cache = settings.models_dir / "huggingface" / "hub" / f"models--{repo_id.replace('/', '--')}"
    snapshots = repo_cache / "snapshots"
    if not snapshots.exists():
        return None
    candidates = [path for path in snapshots.iterdir() if path.is_dir()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def model_statuses() -> list[dict]:
    rows = []
    for model_id, meta in MODEL_REGISTRY.items():
        cache = model_cache_status(model_id)
        try:
            loaded = bool(_tagger_for_model(model_id).is_loaded())
        except ValueError:
            loaded = False
        rows.append({
            **meta,
            "downloaded": cache["downloaded"],
            "files": cache["files"],
            "runtimeAvailable": runtime_available(model_id),
            "loaded": loaded,
            "providers": _model_runtime_providers(model_id),
        })
    return rows


def _model_runtime_providers(model_id: str) -> list[str]:
    if model_id == "wd":
        return list(_wd_tagger._providers)
    if model_id == "camie":
        return list(_camie_tagger._providers)
    return []


def runtime_available(model_id: str) -> bool:
    if model_id in {"wd", "camie"}:
        return find_spec("onnxruntime") is not None and find_spec("numpy") is not None
    if model_id in {"ocr", "whisper"}:
        return find_spec("transformers") is not None and find_spec("torch") is not None
    if model_id == "qwen":
        return (
            find_spec("transformers") is not None
            and find_spec("torch") is not None
            and find_spec("qwen_vl_utils") is not None
        )
    return False


class _ProgressTqdm:
    """Minimal tqdm-compatible progress hook for huggingface_hub downloads."""

    _lock = threading.RLock()

    @classmethod
    def get_lock(cls):
        return cls._lock

    @classmethod
    def set_lock(cls, lock):
        cls._lock = lock

    @classmethod
    def external_write_mode(cls, *args, **kwargs):
        return cls._lock

    def __init__(self, *args, **kwargs):
        self.iterable = args[0] if args else None
        self.total = int(kwargs.get("total") or 0)
        self.n = int(kwargs.get("initial") or 0)
        self.desc = str(kwargs.get("desc") or "")
        self.unit = str(kwargs.get("unit") or "")
        self._job_id = _active_job_id()
        self._model_id = _active_model_id()
        self._closed = False
        self._push(0)

    def __iter__(self):
        if self.iterable is None:
            return iter(())
        for item in self.iterable:
            yield item
            self.update(1)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()

    def update(self, n=1):
        if self._closed:
            return
        self.n += int(n or 0)
        self._push(int(n or 0))

    def close(self):
        self._closed = True

    def reset(self, total=None):
        self.n = 0
        if total is not None:
            self.total = int(total or 0)
        self._push(0)

    def set_description(self, desc=None, refresh=True):
        self.desc = str(desc or "")
        self._push(0)

    def set_postfix(self, *args, **kwargs):
        return None

    def refresh(self):
        self._push(0)

    def _push(self, delta: int):
        if not self._job_id or not self._model_id:
            return
        with _download_lock:
            job = _download_job
            if not job or job.get("id") != self._job_id:
                return
            model = job["models"].get(self._model_id)
            if not model:
                return
            model["current"] = self.desc or model.get("current") or ""
            if self.unit.upper().startswith("B"):
                if self.total > 0:
                    model["bytesTotal"] = max(int(model.get("bytesTotal") or 0), self.total)
                model["bytesDownloaded"] = max(int(model.get("bytesDownloaded") or 0), self.n)
            model["updatedAt"] = time.time()


_download_context = threading.local()


def _active_job_id() -> str | None:
    return getattr(_download_context, "job_id", None)


def _active_model_id() -> str | None:
    return getattr(_download_context, "model_id", None)


def current_download_job() -> dict | None:
    with _download_lock:
        _reconcile_download_job_locked()
        return json.loads(json.dumps(_download_job)) if _download_job else None


def _reconcile_download_job_locked() -> None:
    if not _download_job or _download_job.get("status") not in {"queued", "running"}:
        return

    changed = False
    for model_id in list(_download_job.get("modelIds") or []):
        row = _download_job["models"].get(model_id)
        if not row or row.get("status") == "completed":
            continue
        try:
            cache = model_cache_status(model_id)
        except Exception:
            continue
        if cache.get("downloaded"):
            row["status"] = "completed"
            row["downloaded"] = True
            row["files"] = cache.get("files") or {}
            row["current"] = "Downloaded"
            row["error"] = None
            row["updatedAt"] = time.time()
            changed = True

    if changed:
        completed = sum(1 for row in _download_job["models"].values() if row.get("status") == "completed")
        failed = sum(1 for row in _download_job["models"].values() if row.get("status") == "failed")
        _download_job["completed"] = completed
        _download_job["failed"] = failed
        _download_job["updatedAt"] = time.time()
        if completed + failed >= int(_download_job.get("total") or 0):
            _download_job["status"] = "failed" if failed else "completed"


def start_model_download(model_ids: list[str]) -> dict:
    if find_spec("huggingface_hub") is None:
        raise RuntimeError("huggingface_hub is not installed")
    if not model_ids:
        raise ValueError("No models selected")
    unknown = [model_id for model_id in model_ids if model_id not in MODEL_REGISTRY]
    if unknown:
        raise ValueError(f"Unknown model: {', '.join(unknown)}")

    global _download_job
    with _download_lock:
        if _download_job and _download_job.get("status") in {"queued", "running"}:
            raise RuntimeError("A model download is already running")
        job_id = str(uuid.uuid4())
        _download_job = {
            "id": job_id,
            "status": "queued",
            "modelIds": model_ids,
            "total": len(model_ids),
            "completed": 0,
            "failed": 0,
            "error": None,
            "createdAt": time.time(),
            "updatedAt": time.time(),
            "models": {
                model_id: {
                    "id": model_id,
                    "name": MODEL_REGISTRY[model_id]["name"],
                    "repoId": MODEL_REGISTRY[model_id]["repoId"],
                    "status": "queued",
                    "bytesDownloaded": 0,
                    "bytesTotal": 0,
                    "current": "",
                    "error": None,
                    "updatedAt": time.time(),
                }
                for model_id in model_ids
            },
        }
        snapshot = json.loads(json.dumps(_download_job))

    thread = threading.Thread(target=_run_model_download_job, args=(job_id, model_ids), daemon=True)
    thread.start()
    return snapshot


def _run_model_download_job(job_id: str, model_ids: list[str]) -> None:
    from huggingface_hub import snapshot_download  # type: ignore

    global _download_job
    token = huggingface_token()
    with _download_lock:
        if _download_job and _download_job.get("id") == job_id:
            _download_job["status"] = "running"
            _download_job["updatedAt"] = time.time()

    for model_id in model_ids:
        meta = MODEL_REGISTRY[model_id]
        _download_context.job_id = job_id
        _download_context.model_id = model_id
        with _download_lock:
            if not _download_job or _download_job.get("id") != job_id:
                return
            row = _download_job["models"][model_id]
            row["status"] = "running"
            row["current"] = "Starting download"
            row["updatedAt"] = time.time()
            _download_job["updatedAt"] = time.time()
        try:
            snapshot_download(
                str(meta["repoId"]),
                token=huggingface_token(),
                allow_patterns=meta.get("allowPatterns"),
                tqdm_class=_ProgressTqdm,
            )
            cache = model_cache_status(model_id)
            with _download_lock:
                if not _download_job or _download_job.get("id") != job_id:
                    return
                row = _download_job["models"][model_id]
                row["status"] = "completed"
                row["downloaded"] = cache["downloaded"]
                row["files"] = cache["files"]
                row["current"] = "Downloaded"
                row["updatedAt"] = time.time()
                _download_job["completed"] += 1
                _download_job["updatedAt"] = time.time()
        except Exception as exc:  # noqa: BLE001
            logger.warning("model download failed for %s: %s", model_id, exc)
            with _download_lock:
                if not _download_job or _download_job.get("id") != job_id:
                    return
                row = _download_job["models"][model_id]
                row["status"] = "failed"
                row["error"] = str(exc)
                row["updatedAt"] = time.time()
                _download_job["failed"] += 1
                _download_job["updatedAt"] = time.time()

    with _download_lock:
        if _download_job and _download_job.get("id") == job_id:
            _download_job["status"] = "failed" if _download_job["failed"] else "completed"
            _download_job["updatedAt"] = time.time()
    _download_context.job_id = None
    _download_context.model_id = None


def download_model() -> dict:
    job = start_model_download(["wd"])
    return {
        "model": _wd_tagger.name,
        "modelId": WD_MODEL_ID,
        "downloaded": model_cache_status("wd")["downloaded"],
        "loaded": _wd_tagger.is_loaded(),
        "job": job,
        "huggingFaceTokenConfigured": bool(huggingface_token()),
    }


def tag_media(path: Path, opts: AutoTagOptions | None = None) -> AutoTagResult:
    opts = opts or load_options()
    path = Path(path)
    if not opts.enabled:
        return AutoTagResult(enabled=False, error="disabled")
    if opts.remoteEnabled and opts.remoteUrl:
        return _tag_media_remote(path, opts)
    return _infer_local(path, opts)


def _infer_local(path: Path, opts: AutoTagOptions) -> AutoTagResult:
    """Run the model pipeline in this process (the worker side / local mode)."""
    path = Path(path)
    try:
        if path.suffix.lower() in SUPPORTED_IMAGE_EXTS:
            if not opts.tagImages:
                return AutoTagResult(enabled=True, error="images_disabled")
            return _post_process(_tag_image(path, opts), path, opts)
        if path.suffix.lower() in SUPPORTED_VIDEO_EXTS:
            if not opts.tagVideos:
                return AutoTagResult(enabled=True, error="videos_disabled")
            return _post_process(_tag_video_with_enrichers(path, opts), path, opts)
        return AutoTagResult(enabled=True, error="unsupported_media_type")
    except ImportError as exc:
        logger.warning("auto tagger dependencies are missing: %s", exc)
        return AutoTagResult(enabled=True, model=_wd_tagger.name, error="missing_dependencies")
    except Exception as exc:  # noqa: BLE001
        logger.warning("auto tagger failed for %s: %s", path, exc)
        return AutoTagResult(enabled=True, model=_wd_tagger.name, error=str(exc))


def _tag_media_remote(path: Path, opts: AutoTagOptions) -> AutoTagResult:
    """Forward inference to a remote GPU worker. Never raises: an unreachable
    worker returns a soft error so the caller (e.g. upload) still succeeds."""
    import httpx  # base dependency

    url = f"{opts.remoteUrl.rstrip('/')}/api/auto-tags/infer"
    # The worker must run models locally; never let it bounce the request onward.
    payload = asdict(opts)
    payload["remoteEnabled"] = False
    payload["remoteUrl"] = ""
    headers = {}
    token = tagger_worker_token()
    if token:
        headers["X-Tagger-Token"] = token
    try:
        with open(path, "rb") as fh:
            files = {"file": (path.name, fh)}
            data = {"options": json.dumps(payload)}
            response = httpx.post(
                url,
                files=files,
                data=data,
                headers=headers,
                timeout=float(opts.remoteTimeoutSeconds),
            )
        if response.status_code != 200:
            detail = response.text[:200]
            return AutoTagResult(enabled=True, model="remote", error=f"worker_error_{response.status_code}: {detail}")
        body = response.json()
        return AutoTagResult(
            tags=list(body.get("tags") or []),
            character_tags=list(body.get("characterTags") or []),
            copyright_tags=list(body.get("copyrightTags") or []),
            rating=dict(body.get("rating") or {}),
            safety=body.get("safety"),
            categories=dict(body.get("categories") or {}),
            evidence=dict(body.get("evidence") or {}),
            model=body.get("model") or "remote",
            enabled=bool(body.get("enabled", True)),
            error=body.get("error"),
        )
    except Exception as exc:  # noqa: BLE001 - connection/timeout/parse all degrade softly
        logger.warning("remote tagger worker unreachable at %s: %s", url, exc)
        return AutoTagResult(enabled=True, model="remote", error=f"worker_unreachable: {exc}")


def _tag_image(path: Path, opts: AutoTagOptions) -> AutoTagResult:
    results: list[AutoTagResult] = []
    if opts.wdEnabled:
        results.append(_wd_tagger.tag_image(path, opts))
    results.extend(_optional_image_results(path, opts))
    if not results:
        return AutoTagResult(enabled=True, error="no_models_enabled")
    return _combine_results(results)


def _optional_image_results(path: Path, opts: AutoTagOptions, context: dict | None = None) -> list[AutoTagResult]:
    results: list[AutoTagResult] = []
    if opts.characterModelEnabled:
        results.append(_run_optional("camie", lambda: _camie_tagger.tag_image(path, opts)))
    if opts.ocrEnabled:
        ocr = _run_optional("ocr", lambda: _ocr_tagger.read_image(path))
        results.append(ocr)
        if context is not None and ocr.evidence.get("text"):
            context["ocrText"] = ocr.evidence.get("text")
    if opts.qwenEnabled or opts.semanticPoliticalEnabled:
        results.append(_run_optional("qwen", lambda: _qwen_tagger.analyze_image(path, context=context, opts=opts)))
    return results


def _tag_video_with_enrichers(path: Path, opts: AutoTagOptions) -> AutoTagResult:
    base = _tag_video(path, opts)
    results = [base]
    context: dict = {}
    if opts.whisperEnabled:
        whisper = _run_optional("whisper", lambda: _whisper_tagger.transcribe_video(path, opts))
        results.append(whisper)
        if whisper.evidence.get("transcript"):
            context["transcript"] = whisper.evidence.get("transcript")
    if opts.characterModelEnabled or opts.ocrEnabled or opts.qwenEnabled or opts.semanticPoliticalEnabled:
        frame = _representative_frame(path, opts)
        if frame:
            try:
                results.extend(_optional_image_results(frame, opts, context=context))
            finally:
                shutil.rmtree(frame.parent, ignore_errors=True)
    return _combine_results(results)


def _run_optional(model_id: str, fn) -> AutoTagResult:
    try:
        return fn()
    except ImportError as exc:
        return AutoTagResult(
            enabled=True,
            model=str(MODEL_REGISTRY[model_id]["name"]),
            error=f"missing_runtime_dependency: {exc}",
            evidence={"kind": model_id, "error": f"missing_runtime_dependency: {exc}"},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s pipeline failed: %s", model_id, exc)
        return AutoTagResult(
            enabled=True,
            model=str(MODEL_REGISTRY[model_id]["name"]),
            error=str(exc),
            evidence={"kind": model_id, "error": str(exc)},
        )


def _combine_results(results: list[AutoTagResult]) -> AutoTagResult:
    combined = AutoTagResult(enabled=True)
    evidence_models = []
    errors = []
    for result in results:
        if not result:
            continue
        combined.tags.extend(result.tags)
        combined.character_tags.extend(result.character_tags)
        combined.copyright_tags.extend(result.copyright_tags)
        combined.categories.update(result.categories)
        combined.rating.update(result.rating)
        combined.safety = _higher_safety(combined.safety, result.safety)
        evidence_models.append({
            "model": result.model,
            "error": result.error,
            "evidence": result.evidence,
        })
        if result.error:
            errors.append(f"{result.model}: {result.error}")
    combined.tags = _dedupe_tags(combined.tags)
    combined.character_tags = _dedupe_tags(combined.character_tags)
    combined.copyright_tags = _dedupe_tags(combined.copyright_tags)
    combined.model = "+".join([result.model for result in results if result and result.model])
    combined.evidence = {"models": evidence_models}
    combined.error = "; ".join(errors) if errors and not combined.all_tags else None
    return combined


def merge_with_existing(existing: list[str], result: AutoTagResult, opts: AutoTagOptions) -> tuple[list[str], dict[str, str]]:
    excluded = _excluded_tags(opts)
    raw = list(existing or [])
    raw.extend(result.all_tags)
    if opts.addProvenanceTag and result.all_tags:
        raw.append(opts.provenanceTag)

    seen: set[str] = set()
    out: list[str] = []
    categories = dict(result.categories)
    if opts.addProvenanceTag and result.all_tags:
        categories[normalize_tag(opts.provenanceTag)] = "meta"
    for tag in (normalize_tag(t) for t in raw):
        if tag and tag not in excluded and tag not in seen:
            seen.add(tag)
            out.append(tag)
    categories = {tag: category for tag, category in categories.items() if normalize_tag(tag) in seen}
    return out, categories


def promote_safety(current: str, suggested: str | None, opts: AutoTagOptions) -> str:
    if not opts.applySafety or not suggested:
        return current
    rank = {"safe": 0, "sketchy": 1, "unsafe": 2}
    if opts.neverDowngradeSafety and rank.get(suggested, 0) < rank.get(current, 0):
        return current
    return suggested if rank.get(suggested, 0) > rank.get(current, 0) else current


def normalize_tag(raw: str) -> str:
    tag = str(raw or "").strip().lower().replace(" ", "_")
    tag = re.sub(r"[^\w:.-]+", "_", tag)
    tag = re.sub(r"_+", "_", tag)
    return tag.strip("_")


def _dedupe_tags(tags: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for tag in tags:
        norm = normalize_tag(tag)
        if norm and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def _excluded_tags(opts: AutoTagOptions) -> set[str]:
    return {normalize_tag(t) for t in [*DEFAULT_NOISY_TAGS, *(opts.excludedTags or [])] if normalize_tag(t)}


def _media_type_tag(path: Path) -> str | None:
    return MEDIA_TYPE_TAGS.get(Path(path).suffix.lower())


def _append_media_type_tag(result: AutoTagResult, path: Path) -> None:
    tag = _media_type_tag(path)
    if not tag:
        return
    result.tags.append(tag)
    result.categories[normalize_tag(tag)] = "meta"


def _apply_tag_filters(result: AutoTagResult, opts: AutoTagOptions) -> AutoTagResult:
    excluded = _excluded_tags(opts)
    result.tags = [tag for tag in _dedupe_tags(result.tags) if tag not in excluded]
    result.character_tags = [tag for tag in _dedupe_tags(result.character_tags) if tag not in excluded]
    result.copyright_tags = [tag for tag in _dedupe_tags(result.copyright_tags) if tag not in excluded]
    allowed = set(result.all_tags)
    result.categories = {
        normalize_tag(tag): category
        for tag, category in result.categories.items()
        if normalize_tag(tag) in allowed
    }
    return result


def _higher_safety(left: str | None, right: str | None) -> str | None:
    rank = {"safe": 0, "sketchy": 1, "unsafe": 2}
    if not left:
        return right
    if not right:
        return left
    return right if rank.get(right, 0) > rank.get(left, 0) else left


def _cached_file(files: dict, filename: str) -> str | None:
    if filename in files and files[filename].get("downloaded"):
        return files[filename].get("path")
    for name, meta in files.items():
        if name.endswith(filename) and meta.get("downloaded"):
            return meta.get("path")
    return None


def _imagenet_tensor(path: Path, image_size: int):
    import numpy as np  # type: ignore

    with Image.open(path) as img:
        img = img.convert("RGB")
        width, height = img.size
        scale = min(image_size / width, image_size / height)
        new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
        resized = img.resize(new_size, Image.LANCZOS)
        canvas = Image.new("RGB", (image_size, image_size), (124, 116, 104))
        canvas.paste(resized, ((image_size - new_size[0]) // 2, (image_size - new_size[1]) // 2))
        arr = np.asarray(canvas, dtype=np.float32) / 255.0
    mean = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
    arr = (arr - mean) / std
    return np.transpose(arr, (2, 0, 1))[None, ...].astype(np.float32)


def _camie_safety(rating: dict[str, float], opts: AutoTagOptions) -> str | None:
    normalized = {
        "explicit": max(rating.get("explicit", 0.0), rating.get("rating_explicit", 0.0)),
        "questionable": max(rating.get("questionable", 0.0), rating.get("rating_questionable", 0.0)),
        "sensitive": max(rating.get("sensitive", 0.0), rating.get("rating_sensitive", 0.0)),
        "general": max(rating.get("general", 0.0), rating.get("rating_general", 0.0)),
    }
    return safety_from_rating(normalized, opts)


def _looks_political(text: str) -> bool:
    haystack = str(text or "").lower()
    needles = [
        "president", "election", "vote", "democrat", "republican", "congress",
        "senate", "government", "politic", "campaign", "trump", "biden",
        "war", "protest", "propaganda", "minister", "parliament",
    ]
    return any(needle in haystack for needle in needles)


def _looks_like_music_transcript(text: str) -> bool:
    haystack = str(text or "").lower()
    if "♪" in haystack or "♫" in haystack:
        return True
    needles = [
        "[music]", "(music)", "background music", "song", "singing", "sings",
        "lyrics", "chorus", "verse", "instrumental", "melody", "beat drops",
    ]
    return any(needle in haystack for needle in needles)


def _whisper_tags_from_text(text: str) -> list[str]:
    tags = []
    if str(text or "").strip():
        tags.append("has_speech")
    if _looks_political(text):
        tags.append("political_audio")
    if _looks_like_music_transcript(text):
        tags.extend(["music", "edit"])
    return _dedupe_tags(tags)


def _meaningful_ocr_text(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    alnum = re.findall(r"[a-zA-Z0-9]", normalized)
    if len(alnum) < 6:
        return False
    words = re.findall(r"[a-zA-Z0-9]{2,}", normalized)
    return len(words) >= 2 or len(alnum) >= 10


def _parse_semantic_json(raw: str) -> dict:
    text = str(raw or "").strip()
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        text = match.group(0)
    try:
        data = json.loads(text)
    except Exception:
        return {"tags": [], "raw": raw}
    if not isinstance(data, dict):
        return {"tags": [], "raw": raw}
    tags = data.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    data["tags"] = tags if isinstance(tags, list) else []
    return data


def _extract_audio(source: Path, dest: Path, max_seconds: int) -> bool:
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(source), "-t", str(max_seconds),
                "-vn", "-ac", "1", "-ar", "16000", str(dest),
            ],
            capture_output=True,
            timeout=60,
        )
        return proc.returncode == 0 and dest.exists()
    except Exception:
        return False


def _whisper_audio_seconds(opts: AutoTagOptions) -> int:
    return max(1, min(WHISPER_MAX_AUDIO_SECONDS, int(opts.videoMaxDurationSeconds or WHISPER_MAX_AUDIO_SECONDS)))


def _representative_frame(path: Path, opts: AutoTagOptions) -> Path | None:
    duration = _probe_duration(path)
    timestamps = _timestamps(duration, AutoTagOptions(videoFrameStrategy="middle", videoMaxFrames=1))
    if not timestamps:
        return None
    cache_root = settings.cache_dir / "auto-tags"
    cache_root.mkdir(parents=True, exist_ok=True)
    tmpdir = Path(tempfile.mkdtemp(prefix="representative-", dir=cache_root))
    frame = tmpdir / "frame.jpg"
    if _extract_frame(path, frame, timestamps[0]) and frame.exists():
        return frame
    shutil.rmtree(tmpdir, ignore_errors=True)
    return None


def safety_from_rating(rating: dict[str, float], opts: AutoTagOptions) -> str | None:
    explicit = max(rating.get("explicit", 0.0), rating.get("rating_explicit", 0.0))
    questionable = max(rating.get("questionable", 0.0), rating.get("rating_questionable", 0.0))
    sensitive = max(rating.get("sensitive", 0.0), rating.get("sensitive_content", 0.0))
    if explicit >= opts.unsafeThreshold:
        return "unsafe"
    sketchy_threshold = max(opts.sketchyThreshold, 0.65)
    if (
        explicit >= sketchy_threshold
        or questionable >= max(opts.unsafeThreshold, 0.75)
        or sensitive >= max(sketchy_threshold, 0.75)
    ):
        return "sketchy"
    if rating:
        return "safe"
    return None


def _post_process(result: AutoTagResult, path: Path, opts: AutoTagOptions) -> AutoTagResult:
    _append_media_type_tag(result, path)
    for rule in opts.keywordRules:
        try:
            needle = normalize_tag(rule.get("contains", ""))
            tag = normalize_tag(rule.get("tag", ""))
            scope = str(rule.get("scope", "path"))
            haystack = normalize_tag(str(path if scope == "path" else path.name))
            if needle and tag and needle in haystack:
                result.tags.append(tag)
                result.categories[tag] = "general"
        except Exception:
            continue
    return _apply_tag_filters(result, opts)


def _tag_video(path: Path, opts: AutoTagOptions) -> AutoTagResult:
    if not opts.wdEnabled:
        return AutoTagResult(enabled=True, model=_wd_tagger.name)
    if not check_ffmpeg_available():
        return AutoTagResult(enabled=True, model=_wd_tagger.name, error="ffmpeg_missing")

    duration = _probe_duration(path)
    if duration and duration > opts.videoMaxDurationSeconds:
        duration = float(opts.videoMaxDurationSeconds)
    timestamps = _timestamps(duration, opts)
    if not timestamps:
        return AutoTagResult(enabled=True, model=_wd_tagger.name, error="video_duration_unknown")

    frame_results: list[tuple[float, AutoTagResult]] = []
    cache_root = settings.cache_dir / "auto-tags"
    cache_root.mkdir(parents=True, exist_ok=True)
    tmpdir = Path(tempfile.mkdtemp(prefix="frames-", dir=cache_root))
    try:
        for idx, ts in enumerate(timestamps):
            frame = tmpdir / f"frame-{idx}.jpg"
            if _extract_frame(path, frame, ts) and not _is_near_black(frame):
                frame_results.append((ts, _wd_tagger.tag_image(frame, opts)))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not frame_results:
        return AutoTagResult(enabled=True, model=_wd_tagger.name, error="no_video_frames")

    return _merge_frame_results(frame_results, opts)


def _probe_duration(path: Path) -> float | None:
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", str(path)],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0:
            return float(proc.stdout.strip())
    except Exception:
        return None
    return None


def _timestamps(duration: float | None, opts: AutoTagOptions) -> list[float]:
    if not duration or duration <= 0:
        return []
    if opts.videoFrameStrategy == "middle" or opts.videoMaxFrames == 1:
        points = [0.5]
    elif duration < 8:
        points = [0.5]
    elif duration <= 60:
        points = [0.25, 0.5, 0.75]
    else:
        points = [0.10, 0.35, 0.60, 0.85]
    return [max(0.0, min(duration - 0.05, duration * p)) for p in points[: opts.videoMaxFrames]]


def _extract_frame(source: Path, dest: Path, timestamp: float) -> bool:
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-ss", f"{timestamp:.3f}", "-i", str(source),
                "-frames:v", "1", "-q:v", "2", str(dest),
            ],
            capture_output=True,
            timeout=20,
        )
        return proc.returncode == 0 and dest.exists()
    except Exception:
        return False


def _is_near_black(path: Path) -> bool:
    try:
        with Image.open(path) as img:
            gray = img.convert("L").resize((32, 32))
            pixels = list(gray.getdata())
            return (sum(pixels) / max(1, len(pixels))) < 8
    except Exception:
        return False


def _merge_frame_results(frame_results: list[tuple[float, AutoTagResult]], opts: AutoTagOptions) -> AutoTagResult:
    tag_counts: dict[str, int] = {}
    char_counts: dict[str, int] = {}
    rating_max: dict[str, float] = {}
    evidence_frames = []

    for ts, result in frame_results:
        for tag in result.tags:
            tag_counts[tag] = tag_counts.get(tag, 0) + 1
        for tag in result.character_tags:
            char_counts[tag] = char_counts.get(tag, 0) + 1
        for key, value in result.rating.items():
            rating_max[key] = max(rating_max.get(key, 0.0), float(value))
        evidence_frames.append({
            "timestamp": ts,
            "tags": result.tags[:10],
            "characters": result.character_tags[:10],
            "safety": result.safety,
        })

    frame_count = len(frame_results)
    tags = [
        tag for tag, count in sorted(tag_counts.items(), key=lambda item: (-item[1], item[0]))
        if count >= 2 or frame_count == 1
    ][: opts.maxTags]
    chars = [
        tag for tag, count in sorted(char_counts.items(), key=lambda item: (-item[1], item[0]))
        if count >= 2 or frame_count == 1
    ][: opts.maxTags]
    if "video" not in tags:
        tags.insert(0, "video")
    safety = safety_from_rating(rating_max, opts)
    categories = {tag: "general" for tag in tags}
    categories.update({tag: "character" for tag in chars})
    return AutoTagResult(
        tags=tags,
        character_tags=chars,
        rating=rating_max,
        safety=safety,
        categories=categories,
        evidence={"kind": "video", "frames": evidence_frames, "rating": rating_max},
        model=_wd_tagger.name,
        enabled=True,
    )


def result_to_json(result: AutoTagResult) -> str:
    return json.dumps({
        "tags": result.tags,
        "characterTags": result.character_tags,
        "copyrightTags": result.copyright_tags,
        "rating": result.rating,
        "safety": result.safety,
        "categories": result.categories,
        "evidence": result.evidence,
        "model": result.model,
        "enabled": result.enabled,
        "error": result.error,
    })


def _letterbox(image, target: int):
    width, height = image.size
    scale = min(target / width, target / height)
    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    resized = image.resize(new_size, Image.BICUBIC)
    canvas = Image.new("RGB", (target, target), (255, 255, 255))
    canvas.paste(resized, ((target - new_size[0]) // 2, (target - new_size[1]) // 2))
    return canvas
