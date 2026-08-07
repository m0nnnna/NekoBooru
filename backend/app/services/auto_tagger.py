"""Optional local image/video auto-tagging for NekoBooru."""
from __future__ import annotations

import csv
import base64
import ctypes
import importlib
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
from collections import Counter
from dataclasses import asdict, dataclass, field, replace
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from ..config import settings
from .media import check_ffmpeg_available
from .settings import SettingsManager

logger = logging.getLogger(__name__)
_LLAMA_DLL_DIRECTORY_HANDLES: list[Any] = []
_LLAMA_PRELOAD_HANDLES: list[Any] = []
_ONNX_DLL_DIRECTORY_HANDLES: list[Any] = []
_ONNX_PRELOAD_HANDLES: list[Any] = []
_ONNX_CUDA_PREPARED = False

SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
SUPPORTED_VIDEO_EXTS = {".webm", ".mp4"}
WD_MODEL_ID = "SmilingWolf/wd-eva02-large-tagger-v3"
# CL Tagger v2 ships one subfolder per checkpoint; pin the version we support so
# downloads stay small and the vocabulary always matches the ONNX graph.
CL_MODEL_ID = "cella110n/cl_tagger_v2"
CL_MODEL_VERSION = "v2_01a"
CL_ONNX_FILE = f"{CL_MODEL_VERSION}/model.onnx"
CL_ONNX_DATA_FILE = f"{CL_MODEL_VERSION}/model.onnx.data"
CL_VOCAB_FILE = f"{CL_MODEL_VERSION}/model_vocabulary.json"
CL_METADATA_FILE = f"{CL_MODEL_VERSION}/model_metadata.json"
CL_IMAGE_SIZE = 384
# The model card recommends 0.55 for practical tagging; the per-tag best_thr
# table maximizes F1 but over-tags badly across a 108k-tag vocabulary.
CL_MIN_THRESHOLD = 0.55
CL_RATING_WORDS = {"general", "sensitive", "questionable", "explicit"}
CL_QUALITY_WORDS = {"best quality", "normal quality", "bad quality", "worst quality", "best", "normal", "bad", "worst"}
WHISPER_MAX_AUDIO_SECONDS = 30
QWEN_MIN_FREE_VRAM_GB = 18.0
QWEN_ANALYSIS_MAX_SIDE = 900
QWEN_VIDEO_FPS = 2.0
QWEN_MAX_NEW_TOKENS = 512
QWEN_GGUF_MAX_TOKENS = 512
QWEN_GGUF_REPO_ID = "Qwen/Qwen3-VL-8B-Instruct-GGUF"
QWEN_GGUF_MMPROJ_FILE = "mmproj-Qwen3VL-8B-Instruct-F16.gguf"
QWEN_GGUF_FILE_SIZES = {
    "Qwen3VL-8B-Instruct-Q4_K_M.gguf": 5_027_784_800,
    "Qwen3VL-8B-Instruct-Q8_0.gguf": 8_709_519_456,
    "mmproj-Qwen3VL-8B-Instruct-F16.gguf": 1_159_029_824,
}
QWEN_SEMANTIC_MODEL_IDS = {"qwen", "qwen_gguf_q4", "qwen_gguf_q8"}
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
    "pixai": {
        "id": "pixai",
        "name": "PixAI Tagger v0.9",
        "repoId": "deepghs/pixai-tagger-v0.9-onnx",
        "purpose": "Fast Danbooru-style anime/illustration tags from PixAI Tagger v0.9",
        "downloadSize": "~1.3 GB",
        "vramRequirement": "~0.5-1.5 GB",
        "status": "tagging_ready",
        "allowPatterns": None,
        "requiredFileKinds": ["onnx", "tags"],
        "expectedTotalBytes": 1_272_005_678,
        "characterThreshold": 0.85,
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
        "requiredFiles": ["camie-tagger-v2.onnx", "camie-tagger-v2-metadata.json"],
    },
    "cl": {
        "id": "cl",
        "name": "CL Tagger v2",
        "repoId": CL_MODEL_ID,
        "purpose": "SigLIP2 Danbooru tagger with a 108k-tag character/copyright/general vocabulary",
        "downloadSize": "~2.3 GB",
        "vramRequirement": "~2-3 GB",
        "status": "tagging_ready",
        "version": CL_MODEL_VERSION,
        # Gated repo (auto-approved): the user has to accept the license on the
        # model page once and save a Hugging Face token before downloading.
        "gated": True,
        "gatedUrl": f"https://huggingface.co/{CL_MODEL_ID}",
        # Large and gated, so keep it out of "Download all" — it would fail the
        # whole batch for anyone who has not accepted the license yet.
        "downloadAll": False,
        "allowPatterns": [CL_ONNX_FILE, CL_ONNX_DATA_FILE, CL_VOCAB_FILE, CL_METADATA_FILE],
        "requiredFiles": [CL_ONNX_FILE, CL_ONNX_DATA_FILE, CL_VOCAB_FILE],
        "expectedTotalBytes": 2_227_031_325,
        "generalThreshold": CL_MIN_THRESHOLD,
        "characterThreshold": CL_MIN_THRESHOLD,
    },
    "qwen": {
        "id": "qwen",
        "name": "Qwen2.5-VL 7B Instruct",
        "repoId": "Qwen/Qwen2.5-VL-7B-Instruct",
        "purpose": "Semantic video/edit understanding, political context, and natural-language evidence",
        "downloadSize": "~15-17 GB",
        "vramRequirement": "~14-18 GB fp16, 24 GB comfortable",
        "status": "tagging_ready",
        "role": "semantic",
        "backend": "transformers",
        "downloadAll": True,
        "allowPatterns": None,
        "requiredFiles": ["config.json"],
    },
    "qwen_gguf_q4": {
        "id": "qwen_gguf_q4",
        "name": "Qwen3-VL 8B GGUF Q4",
        "repoId": QWEN_GGUF_REPO_ID,
        "purpose": "Fast local semantic image/video-frame understanding through llama.cpp GGUF",
        "downloadSize": "~6.4 GB",
        "vramRequirement": "~6-8 GB, 8-12 GB comfortable",
        "status": "tagging_ready",
        "role": "semantic",
        "backend": "gguf",
        "quantization": "Q4_K_M",
        "downloadAll": False,
        "storage": "local_files",
        "allowPatterns": ["Qwen3VL-8B-Instruct-Q4_K_M.gguf", QWEN_GGUF_MMPROJ_FILE],
        "requiredFiles": ["Qwen3VL-8B-Instruct-Q4_K_M.gguf", QWEN_GGUF_MMPROJ_FILE],
        "fileSizes": QWEN_GGUF_FILE_SIZES,
    },
    "qwen_gguf_q8": {
        "id": "qwen_gguf_q8",
        "name": "Qwen3-VL 8B GGUF Q8",
        "repoId": QWEN_GGUF_REPO_ID,
        "purpose": "Higher-quality local semantic image/video-frame understanding through llama.cpp GGUF",
        "downloadSize": "~10.0 GB",
        "vramRequirement": "~10-12 GB, 12-16 GB comfortable",
        "status": "tagging_ready",
        "role": "semantic",
        "backend": "gguf",
        "quantization": "Q8_0",
        "downloadAll": False,
        "storage": "local_files",
        "allowPatterns": ["Qwen3VL-8B-Instruct-Q8_0.gguf", QWEN_GGUF_MMPROJ_FILE],
        "requiredFiles": ["Qwen3VL-8B-Instruct-Q8_0.gguf", QWEN_GGUF_MMPROJ_FILE],
        "fileSizes": QWEN_GGUF_FILE_SIZES,
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
        "requiredFiles": ["config.json", "model.safetensors", "preprocessor_config.json"],
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
        "requiredFiles": ["config.json"],
    },
}

_download_lock = threading.Lock()
_download_job: dict[str, Any] | None = None
_load_lock = threading.Lock()
_load_job: dict[str, Any] | None = None
_load_queue: list[str] = []
_load_worker: threading.Thread | None = None
# Serializes everything that touches the GPU: inference and model loads/unloads.
# Without it a bulk tag run and a "Load model" click allocate VRAM at the same
# time and the process dies on an out-of-memory error mid-job. Held per media
# item rather than per job so a queued load still gets a turn promptly.
_gpu_work_lock = threading.RLock()
_DOWNLOAD_ACTIVE_STATUSES = {"queued", "running", "cancelling"}
_DOWNLOAD_TERMINAL_STATUSES = {"completed", "failed", "cancelled", "skipped"}


class DownloadCancelled(RuntimeError):
    pass

DEFAULT_SEMANTIC_PROMPT = (
    "Return compact JSON with keys: tags, safety, rationale, safety_reason, confidence.\n"
    "Use snake_case tags only.\n\n"
    "Semantic description:\n"
    "- The rationale should be a direct factual caption of the visible content. Describe clothing garments, pose, setting, text, and audio/transcript evidence. When describing adult or NSFW visual content, respond plainly with a clear safety classification. If the content is erotic or sexually suggestive, say so plainly and explain why. Do not euphemize visible adult content, but do not invent details that are not visible. If lewd, sketchy, unsafe, or nsfw, explain the concrete visual reason: visible or emphasized body parts, nudity or partial nudity, transparent/tight/revealing garments, lingerie, swimwear, cleavage, underboob, sideboob, pose, framing, explicit acts, and why the safety rating was selected. Do not rely only on suggestive pose. Do not mention sampled frame counts, frame labels, contact sheets, timestamps, or model sampling mechanics.\n\n"
    "Example expected rationale style:\n"
    "\"A single woman with long black hair and brown eyes is shown in a video. She wears a white lace bra and matching panties, revealing her breasts and cleavage. She smiles at the camera while sitting indoors, sometimes touching her head or hair, occasionally resting her hand on her chest or stomach. The setting appears to be an indoor room with soft lighting. Visible details include a mole under her mouth, bare shoulders, and her navel. The content is explicitly erotic due to the revealing lingerie, prominent cleavage, and suggestive poses.\"\n\n"
    "Safety values:\n"
    "- Use safety safe for ordinary SFW content, sketchy for suggestive/revealing content, and unsafe for explicit NSFW/adult erotic content. safety_reason should briefly explain the classification based only on visible evidence. confidence must be low, medium, or high.\n\n"
    "Tags in priority order:\n"
    "- Return 6-28 useful searchable tags supported by the image, frame, OCR, transcript, or source page.\n"
    "- For video frame collections or contact sheets, compare the sampled frames in order and infer temporal context, but describe it as the video/content, and do not output metadata tags or mention metadata such as frame_1, frame_2, three_frames, timestamps, contact_sheet, or sampled_frame.\n"
    "- When model tag hints are provided, use only their visual tags as grounding. Prefer specific animal type, ear, horn, tail, and clothing hints unless the image clearly contradicts them. Do not output named character, franchise, copyright, or source tags, and do not mention guessed identities in the rationale.\n"
    "- Start with directly visible tags: media type, exact pose/action, subject count, male/female/girl/boy, setting, objects, actions, expression, hair color, eye color, framing, text/audio presence, and meme/edit format.\n"
    "- Always include the main visible pose or action as a searchable tag when clear, such as lying, sitting, standing, kneeling, crouching, squatting, walking, running, jumping, dancing, sleeping, stretching, arms_up, looking_at_viewer, or selfie.\n"
    "- Decompose clothing into specific garments and attributes. Name the garment type separately from pattern or theme. Example cow_print_outfit, bikini, swimsuit, would all be included.\n"
    "- Do not confuse animal ears types or horns for clothing, or horns for ears. Tag what is visibly present, such as animal_ears, cow_horns, white_horns, tail, or cow_tail.\n"
    "- Add frequent or matching primary colors for the scene or clothing, hair color, eye color, standout accessories, exact pose, and anything visually distinctive.\n"
    "- Include screenshot, photo, video, image, or gif when they fit.\n"
    "- If lewd or nsfw explain what is erotic about it with concrete visible evidence, not only pose.\n"
    "- Add semantic/context tags only when supported: political_edit, meme_edit, amv, music_video, captioned, protest, politician, propaganda, music, edit, has_text, text_overlay, has_speech, swastika, sonnenrad, black_sun, national_socialism, hammer_and_sickle, communism."
)
LEGACY_SEMANTIC_PROMPTS = {
    (
        "Return compact JSON only with keys tags, safety, rationale. "
        "Use snake_case tags. Look for higher-level context such as political_edit, meme_edit, amv, music_video, "
        "captioned, protest, politician, propaganda, and contextual edit signals only when visually or transcript supported. "
        "Use national_socialism only for clear Nazi/far-right symbols such as a swastika, sonnenrad, or black_sun. "
        "Use communism only for clear communist symbols such as a hammer_and_sickle or communist red star. "
        "If transcript or audio evidence suggests a song or music-driven edit, include music and edit."
    ),
    "Return JSON semantic tags.",
}


@dataclass
class AutoTagOptions:
    enabled: bool = False
    tagNewUploads: bool = False
    tagNewImports: bool = False
    tagImages: bool = True
    tagVideos: bool = True
    wdEnabled: bool = True
    pixaiEnabled: bool = False
    clEnabled: bool = False
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
    qwenVideoUseFps: bool = False
    qwenVideoMaxFrames: int = 20
    videoMaxDurationSeconds: int = 900
    semanticPoliticalEnabled: bool = False
    semanticPrompt: str = DEFAULT_SEMANTIC_PROMPT
    ocrEnabled: bool = False
    whisperEnabled: bool = False
    qwenEnabled: bool = False
    semanticModelId: str = "qwen"
    semanticPromptEnabled: bool = True
    semanticSearchEnabled: bool = False
    saveSemanticAnalysis: bool = False
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
    duration_ms: int = 0

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
        model_path = hf_hub_download(WD_MODEL_ID, "model.onnx", token=token, cache_dir=_hf_cache_dir())
        if progress:
            progress("resolve_tags", 22, "Resolving tag metadata")
        tags_path = hf_hub_download(WD_MODEL_ID, "selected_tags.csv", token=token, cache_dir=_hf_cache_dir())
        if progress:
            progress("load_weights", 35, "Loading ONNX weights into memory")
        self._session = _create_onnx_session(ort, model_path)
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


class PixAiTagger:
    name = "pixai-tagger-v0.9"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._session = None
        self._tag_rows: list[tuple[str, str]] = []
        self._image_size = 448
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
        import onnxruntime as ort  # type: ignore

        cache = model_cache_status("pixai")
        files = cache.get("files") or {}
        model_path = _cached_file_by_suffix(files, ".onnx")
        tags_path = _cached_tag_metadata_file(files)
        if not model_path or not tags_path:
            raise RuntimeError("PixAI model files are not downloaded")

        if progress:
            progress("load_weights", 35, "Loading PixAI ONNX weights into memory")
        self._session = _create_onnx_session(ort, model_path)
        self._providers = list(self._session.get_providers())
        self._image_size = _onnx_input_image_size(self._session, default=448)
        if progress:
            progress("read_tags", 85, "Reading PixAI tag metadata")
        self._tag_rows = _read_pixai_tag_rows(Path(tags_path))
        if not self._tag_rows:
            raise RuntimeError("PixAI tag metadata did not contain any tags")

    def tag_image(self, path: Path, opts: AutoTagOptions) -> AutoTagResult:
        self.ensure_loaded()
        import numpy as np  # type: ignore

        input_meta = self._session.get_inputs()[0]
        arr = _generic_onnx_image_tensor(path, self._image_size, input_meta.shape)
        outputs = self._session.run(None, {input_meta.name: arr})
        scores = _flatten_onnx_scores(outputs, np)

        by_category: dict[str, list[tuple[str, float]]] = {
            "general": [],
            "character": [],
            "copyright": [],
            "artist": [],
            "rating": [],
        }
        for (name, category), score in zip(self._tag_rows, scores):
            confidence = float(score)
            tag = normalize_tag(name)
            if not tag:
                continue
            if category == "character":
                threshold = max(float(opts.characterThreshold), float(MODEL_REGISTRY["pixai"].get("characterThreshold") or 0.85))
            elif category in {"copyright", "artist"}:
                threshold = opts.characterThreshold
            else:
                threshold = opts.generalThreshold
            if category == "rating":
                if confidence >= 0.01:
                    by_category["rating"].append((tag, confidence))
            elif confidence >= threshold:
                by_category.setdefault(category, by_category["general"]).append((tag, confidence))

        for category in by_category:
            by_category[category].sort(key=lambda item: item[1], reverse=True)

        max_tags = max(1, int(opts.maxTags))
        rating = {tag.replace("rating_", ""): score for tag, score in by_category.get("rating", [])[:8]}
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
            safety=safety_from_rating(rating, opts) if rating else None,
            categories=categories,
            evidence={
                "kind": "pixai",
                "topTags": [{"tag": n, "confidence": c} for n, c in by_category.get("general", [])[:10]],
                "topCharacters": [{"tag": n, "confidence": c} for n, c in by_category.get("character", [])[:10]],
                "topCopyrights": [{"tag": n, "confidence": c} for n, c in by_category.get("copyright", [])[:10]],
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
        self._session = _create_onnx_session(ort, model_path)
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


class ClTagger:
    """CL Tagger v2 (SigLIP2 so400m-patch14-384 + LoRA head, ONNX)."""

    name = "cl-tagger-v2"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._session = None
        self._input_name = "pixel_values"
        self._idx_to_tag: dict[int, str] = {}
        self._tag_to_category: dict[str, str] = {}
        self._image_size = CL_IMAGE_SIZE
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
        import onnxruntime as ort  # type: ignore

        cache = model_cache_status("cl")
        files = cache.get("files") or {}
        model_path = _cached_file(files, "model.onnx")
        vocab_path = _cached_file(files, "model_vocabulary.json")
        if not model_path or not vocab_path:
            raise RuntimeError("CL Tagger model files are not downloaded")

        if progress:
            progress("load_weights", 35, "Loading CL Tagger ONNX weights into memory")
        # model.onnx keeps its weights in the sibling model.onnx.data file, which
        # onnxruntime resolves relative to the model path.
        self._session = _create_onnx_session(ort, model_path)
        self._providers = list(self._session.get_providers())
        inputs = self._session.get_inputs()
        self._input_name = inputs[0].name if inputs else "pixel_values"
        if len(inputs) > 1:
            raise RuntimeError(
                "This CL Tagger checkpoint expects NaFlex inputs "
                f"({', '.join(item.name for item in inputs)}), which is not supported"
            )
        self._image_size = _onnx_input_image_size(self._session, default=CL_IMAGE_SIZE)
        if progress:
            progress("read_tags", 85, "Reading CL Tagger vocabulary")
        self._idx_to_tag, self._tag_to_category = _read_cl_vocabulary(Path(vocab_path))
        if not self._idx_to_tag:
            raise RuntimeError("CL Tagger vocabulary did not contain any tags")

    def tag_image(self, path: Path, opts: AutoTagOptions) -> AutoTagResult:
        self.ensure_loaded()
        import numpy as np  # type: ignore

        arr = _siglip_tensor(path, self._image_size)
        outputs = self._session.run(None, {self._input_name: arr})
        logits = _flatten_onnx_scores(outputs, np).astype(np.float64)
        probs = 1.0 / (1.0 + np.exp(-logits))

        general_threshold = max(float(opts.generalThreshold), CL_MIN_THRESHOLD)
        character_threshold = max(float(opts.characterThreshold), CL_MIN_THRESHOLD)
        by_category: dict[str, list[tuple[str, float]]] = {
            "general": [],
            "character": [],
            "copyright": [],
            "meta": [],
            "rating": [],
        }
        for idx, score in enumerate(probs):
            raw_tag = self._idx_to_tag.get(idx)
            if not raw_tag:
                continue
            category = self._tag_to_category.get(raw_tag)
            if category is None or category == "quality":
                continue
            tag = normalize_tag(raw_tag)
            if not tag:
                continue
            confidence = float(score)
            if category == "rating":
                if confidence >= 0.01:
                    by_category["rating"].append((tag, confidence))
                continue
            threshold = character_threshold if category in {"character", "copyright"} else general_threshold
            if confidence >= threshold:
                by_category.setdefault(category, []).append((tag, confidence))

        for category in by_category:
            by_category[category].sort(key=lambda item: item[1], reverse=True)

        max_tags = max(1, int(opts.maxTags))
        rating = {tag: score for tag, score in by_category.get("rating", [])[:8]}
        tags = [tag for tag, _ in by_category.get("general", [])[:max_tags]]
        character_tags = [tag for tag, _ in by_category.get("character", [])[:max_tags]]
        copyright_tags = [tag for tag, _ in by_category.get("copyright", [])[:max_tags]]
        categories = {tag: "general" for tag in tags}
        categories.update({tag: "character" for tag in character_tags})
        categories.update({tag: "copyright" for tag in copyright_tags})

        return AutoTagResult(
            tags=tags,
            character_tags=character_tags,
            copyright_tags=copyright_tags,
            rating=rating,
            safety=_camie_safety(rating, opts) if rating else None,
            categories=categories,
            evidence={
                "kind": "cl",
                "version": CL_MODEL_VERSION,
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
            self._processor = TrOCRProcessor.from_pretrained(
                repo_id,
                token=huggingface_token(),
                local_files_only=True,
                cache_dir=_hf_cache_dir(),
            )
            self._model = VisionEncoderDecoderModel.from_pretrained(
                repo_id,
                token=huggingface_token(),
                local_files_only=True,
                cache_dir=_hf_cache_dir(),
            )
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
            pipeline = _transformers_pipeline()

            self._pipeline = pipeline(
                "automatic-speech-recognition",
                model=MODEL_REGISTRY["whisper"]["repoId"],
                token=huggingface_token(),
                local_files_only=True,
                cache_dir=_hf_cache_dir(),
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
            self._processor = AutoProcessor.from_pretrained(
                repo_id,
                token=huggingface_token(),
                local_files_only=True,
                cache_dir=_hf_cache_dir(),
            )
            self._model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                repo_id,
                token=huggingface_token(),
                local_files_only=True,
                cache_dir=_hf_cache_dir(),
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

        prompt = _semantic_prompt_with_context(opts, context)
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
        generated_ids = self._model.generate(
            **inputs,
            max_new_tokens=QWEN_MAX_NEW_TOKENS,
            repetition_penalty=1.08,
            no_repeat_ngram_size=6,
        )
        trimmed = [out[len(inp):] for inp, out in zip(inputs.input_ids, generated_ids)]
        output = self._processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
        parsed = _parse_semantic_json(output)
        parsed = _sanitize_qwen_semantic_payload(parsed, context)
        tags = [normalize_tag(tag) for tag in parsed.get("tags", []) if normalize_tag(tag)]
        safety = normalize_safety_label(parsed.get("safety"))
        max_tags = _semantic_tag_limit(opts)
        tags = tags[:max_tags]
        parsed["tags"] = tags
        raw_evidence = _compact_semantic_raw_output(output, parsed)
        return AutoTagResult(
            tags=tags,
            safety=safety,
            categories={tag: "general" for tag in tags},
            evidence={"kind": "qwen", "raw": raw_evidence, "parsed": parsed, **_analysis_image_evidence(path)},
            model=self.name,
            enabled=True,
        )

    def analyze_video(self, path: Path, context: dict | None = None, opts: AutoTagOptions | None = None) -> AutoTagResult:
        opts = opts or load_options()
        self.ensure_loaded(opts.torchDevice)
        from qwen_vl_utils import process_vision_info  # type: ignore

        prompt = _semantic_prompt_with_context(opts, context)
        frame_cap = max(2, min(64, int(opts.qwenVideoMaxFrames or 20)))
        messages = [{
            "role": "user",
            "content": [
                {
                    "type": "video",
                    "video": str(path),
                    "fps": QWEN_VIDEO_FPS,
                    "min_frames": 2,
                    "max_frames": frame_cap,
                },
                {"type": "text", "text": prompt},
            ],
        }]
        text = self._processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        image_inputs, video_inputs, video_kwargs = process_vision_info(messages, return_video_kwargs=True)
        inputs = self._processor(
            text=[text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
            **(video_kwargs or {}),
        )
        inputs = inputs.to(self._model.device)
        generated_ids = self._model.generate(
            **inputs,
            max_new_tokens=QWEN_MAX_NEW_TOKENS,
            repetition_penalty=1.08,
            no_repeat_ngram_size=6,
        )
        trimmed = [out[len(inp):] for inp, out in zip(inputs.input_ids, generated_ids)]
        output = self._processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
        parsed = _parse_semantic_json(output)
        parsed = _sanitize_qwen_semantic_payload(parsed, context)
        tags = [normalize_tag(tag) for tag in parsed.get("tags", []) if normalize_tag(tag)]
        safety = normalize_safety_label(parsed.get("safety"))
        max_tags = _semantic_tag_limit(opts)
        tags = tags[:max_tags]
        parsed["tags"] = tags
        raw_evidence = _compact_semantic_raw_output(output, parsed)
        frame_count = _video_input_frame_count(video_inputs)
        return AutoTagResult(
            tags=tags,
            safety=safety,
            categories={tag: "general" for tag in tags},
            evidence={
                "kind": "qwen",
                "raw": raw_evidence,
                "parsed": parsed,
                "videoFrames": {
                    "mode": "native_video_2fps",
                    "count": frame_count,
                    "fps": QWEN_VIDEO_FPS,
                    "maxFrames": frame_cap,
                },
            },
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


class QwenGgufSemanticTagger:
    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.name = str(MODEL_REGISTRY[model_id]["name"])
        self._lock = threading.Lock()
        self._loaded = False
        self._llm = None
        self._device_preference = None

    def is_loaded(self) -> bool:
        return self._loaded

    def unload(self) -> bool:
        with self._lock:
            was_loaded = self._loaded
            self._llm = None
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
                self._llm = None
                self._loaded = False
                self._device_preference = None
                _clear_torch_cache()

            _prepare_llama_cpp_runtime()
            from llama_cpp import Llama  # type: ignore

            model_path, mmproj_path = _qwen_gguf_paths(self.model_id)
            n_gpu_layers = -1 if _qwen_gguf_use_gpu(device_preference) else 0
            kwargs = {
                "model_path": str(model_path),
                "n_ctx": 4096,
                "n_gpu_layers": n_gpu_layers,
                "verbose": False,
            }
            try:
                import inspect

                params = inspect.signature(Llama.__init__).parameters
                if "mmproj" in params:
                    kwargs["mmproj"] = str(mmproj_path)
                elif "clip_model_path" in params:
                    kwargs["clip_model_path"] = str(mmproj_path)
                elif "chat_handler" in params:
                    from llama_cpp import llama_chat_format  # type: ignore

                    handler_cls = (
                        getattr(llama_chat_format, "Qwen3VLChatHandler", None)
                        or getattr(llama_chat_format, "Qwen25VLChatHandler", None)
                    )
                    if handler_cls:
                        kwargs["chat_handler"] = handler_cls(clip_model_path=str(mmproj_path))
            except Exception:
                pass
            self._llm = Llama(**kwargs)
            self._loaded = True
            self._device_preference = device_preference
            return True

    def analyze_image(self, path: Path, context: dict | None = None, opts: AutoTagOptions | None = None) -> AutoTagResult:
        opts = opts or load_options()
        self.ensure_loaded(opts.torchDevice)
        prompt = _semantic_prompt_with_context(opts, context)
        if isinstance(context, dict) and context.get("qwenInputMode") == "contact_sheet":
            prompt += (
                "\n\nGGUF video frame instruction:\n"
                "You are an expert video analysis model. These are video frames arranged in a grid only because of the "
                "runtime input format. Analyze them as a temporal video sequence. Do not mention how the frames are "
                "presented to you, and do not describe the content as a grid, collage, contact sheet, slideshow, or "
                "collection of images."
            )
        image_url = _image_data_url(path)
        output = self._llm.create_chat_completion(
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }],
            max_tokens=QWEN_GGUF_MAX_TOKENS,
            temperature=0.2,
            repeat_penalty=1.12,
            response_format={"type": "json_object"},
        )
        text = _chat_completion_text(output)
        parsed = _parse_semantic_json(text)
        parsed = _sanitize_qwen_semantic_payload(parsed, context)
        tags = [normalize_tag(tag) for tag in parsed.get("tags", []) if normalize_tag(tag)]
        safety = normalize_safety_label(parsed.get("safety"))
        max_tags = _semantic_tag_limit(opts)
        tags = tags[:max_tags]
        parsed["tags"] = tags
        raw_evidence = _compact_semantic_raw_output(text, parsed)
        return AutoTagResult(
            tags=tags,
            safety=safety,
            categories={tag: "general" for tag in tags},
            evidence={"kind": "qwen_gguf", "raw": raw_evidence, "parsed": parsed, "modelId": self.model_id, **_analysis_image_evidence(path)},
            model=self.name,
            enabled=True,
        )

    def device_info(self) -> dict:
        return {
            "preference": self._device_preference,
            "loaded": self._loaded,
            "device": "llama.cpp",
            "deviceMap": None,
            "modelId": self.model_id,
        }


_camie_tagger = CamieTagger()
_cl_tagger = ClTagger()
_pixai_tagger = PixAiTagger()
_ocr_tagger = OcrTagger()
_whisper_tagger = WhisperTagger()
_qwen_tagger = QwenSemanticTagger()
_qwen_gguf_q4_tagger = QwenGgufSemanticTagger("qwen_gguf_q4")
_qwen_gguf_q8_tagger = QwenGgufSemanticTagger("qwen_gguf_q8")
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
        "pixaiProviders": list(_pixai_tagger._providers),
        "camieProviders": list(_camie_tagger._providers),
        "clProviders": list(_cl_tagger._providers),
    }
    if not info["available"]:
        return info
    try:
        import onnxruntime as ort  # type: ignore

        info["availableProviders"] = list(ort.get_available_providers())
        info["preferredProviders"] = _onnx_providers(ort)
    except Exception as exc:  # noqa: BLE001
        info["available"] = False
        info["error"] = str(exc)
    return info


# CUDA/cuDNN libraries onnxruntime_providers_cuda.dll links against, in load
# order. cuDNN 9 is split into sub-libraries that must be resident before
# cudnn64_9.dll itself will initialize.
_ONNX_CUDA_DLLS = (
    "cudart64_12.dll",
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "nvJitLink_120_0.dll",
    "cufft64_11.dll",
    "curand64_10.dll",
    "cusparse64_12.dll",
    "cusolver64_11.dll",
    "cudnn_graph64_9.dll",
    "cudnn_engines_precompiled64_9.dll",
    "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_heuristic64_9.dll",
    "cudnn_ops64_9.dll",
    "cudnn_adv64_9.dll",
    "cudnn_cnn64_9.dll",
    "cudnn64_9.dll",
)


def _prepare_onnx_cuda_runtime() -> None:
    """Preload CUDA/cuDNN so onnxruntime can build its CUDA provider on Windows.

    onnxruntime-gpu ships no CUDA libraries of its own; it dlopens cuDNN 9 and
    the CUDA 12 runtime by bare name. Those DLLs are already on disk inside the
    torch wheel (or the nvidia-* wheels), but they live in a directory Windows
    never searches, so provider creation fails with "Require cuDNN 9.* and
    CUDA 12.*" and every ONNX tagger silently falls back to CPU. Putting the
    directory on the search path is not enough — the libraries have to be
    resident — so preload them here and keep the handles alive for the process.
    """
    global _ONNX_CUDA_PREPARED
    if _ONNX_CUDA_PREPARED or os.name != "nt":
        return
    _ONNX_CUDA_PREPARED = True

    candidates: list[Path] = []
    torch_spec = find_spec("torch")
    if torch_spec and torch_spec.origin:
        torch_root = Path(torch_spec.origin).resolve().parent
        candidates.append(torch_root / "lib")
        nvidia_root = torch_root.parent / "nvidia"
        if nvidia_root.exists():
            candidates.extend(path for path in nvidia_root.rglob("bin") if path.is_dir())
    lib_dirs = [path for path in candidates if path.is_dir()]
    if not lib_dirs:
        return

    for path in lib_dirs:
        if hasattr(os, "add_dll_directory"):
            try:
                _ONNX_DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(path)))
            except OSError as exc:
                logger.debug("Unable to add ONNX CUDA DLL directory %s: %s", path, exc)

    loaded = 0
    for name in _ONNX_CUDA_DLLS:
        path = next((directory / name for directory in lib_dirs if (directory / name).exists()), None)
        if not path:
            continue
        try:
            _ONNX_PRELOAD_HANDLES.append(ctypes.WinDLL(str(path)))
            loaded += 1
        except OSError as exc:
            logger.debug("Unable to preload CUDA DLL %s: %s", path, exc)
    if loaded:
        logger.info("Preloaded %d CUDA/cuDNN libraries for the onnxruntime CUDA provider", loaded)


def _create_onnx_session(ort, model_path: str):
    _prepare_onnx_cuda_runtime()
    providers = _onnx_providers(ort)
    try:
        return ort.InferenceSession(model_path, providers=providers)
    except Exception as exc:  # noqa: BLE001
        if providers != ["CPUExecutionProvider"]:
            logger.warning("ONNX GPU provider failed for %s; retrying CPU provider: %s", model_path, exc)
            return ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        raise


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


def _qwen_gguf_use_gpu(device_preference: str) -> bool:
    device_preference = _normalize_torch_device(device_preference)
    if device_preference == "cpu":
        return False
    if device_preference == "gpu":
        _ensure_qwen_gpu_headroom()
        return True
    return bool(_qwen_gpu_memory_info().get("available"))


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


def _image_data_url(path: Path) -> str:
    suffix = path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(suffix, "image/png")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _analyze_qwen_image(tagger, path: Path, context: dict | None = None, opts: AutoTagOptions | None = None) -> AutoTagResult:
    analysis_path = _qwen_analysis_image(path)
    try:
        result = tagger.analyze_image(analysis_path, context=context, opts=opts)
        if analysis_path != path and isinstance(result.evidence, dict):
            result.evidence["sourceImage"] = str(path)
        return result
    finally:
        if analysis_path != path:
            shutil.rmtree(analysis_path.parent, ignore_errors=True)


def _analyze_qwen_video_frames(
    tagger,
    frames: list[tuple[float, Path]],
    context: dict | None = None,
    opts: AutoTagOptions | None = None,
    mode: str = "single",
) -> AutoTagResult:
    if not frames:
        return AutoTagResult(enabled=True, model=getattr(tagger, "name", "qwen"), error="no_video_frames")
    if len(frames) == 1:
        result = _analyze_qwen_image(tagger, frames[0][1], context=context, opts=opts)
        if isinstance(result.evidence, dict):
            result.evidence["videoFrames"] = {
                "mode": "single",
                "count": 1,
                "timestamps": [round(frames[0][0], 3)],
            }
        return result
    sheet = _qwen_frame_contact_sheet(frames)
    qwen_context = dict(context or {})
    qwen_context["qwenInputMode"] = "contact_sheet"
    try:
        result = _analyze_qwen_image(tagger, sheet, context=qwen_context, opts=opts)
        if isinstance(result.evidence, dict):
            result.evidence["videoFrames"] = {
                "mode": mode,
                "count": len(frames),
                "timestamps": [round(ts, 3) for ts, _ in frames],
            }
        return result
    finally:
        shutil.rmtree(sheet.parent, ignore_errors=True)


def _qwen_analysis_image(path: Path, max_side: int = QWEN_ANALYSIS_MAX_SIDE) -> Path:
    try:
        with Image.open(path) as img:
            width, height = img.size
            if max(width, height) <= max_side:
                return path
            scale = max_side / max(width, height)
            size = (max(1, round(width * scale)), max(1, round(height * scale)))
            cache_root = settings.cache_dir / "auto-tags"
            cache_root.mkdir(parents=True, exist_ok=True)
            tmpdir = Path(tempfile.mkdtemp(prefix="qwen-analysis-", dir=cache_root))
            dest = tmpdir / "image.jpg"
            resized = img.convert("RGB").resize(size, Image.Resampling.LANCZOS)
            resized.save(dest, "JPEG", quality=92, optimize=True)
            return dest
    except Exception:
        return path


def _qwen_frame_contact_sheet(frames: list[tuple[float, Path]]) -> Path:
    cache_root = settings.cache_dir / "auto-tags"
    cache_root.mkdir(parents=True, exist_ok=True)
    tmpdir = Path(tempfile.mkdtemp(prefix="qwen-frames-", dir=cache_root))
    columns = 2 if len(frames) <= 4 else 3
    rows = max(1, math.ceil(len(frames) / columns))
    cell_w = 420
    cell_h = 420
    gap = 8
    sheet = Image.new("RGB", (columns * cell_w + (columns - 1) * gap, rows * cell_h + (rows - 1) * gap), (18, 20, 24))
    draw = ImageDraw.Draw(sheet)
    for idx, (_timestamp, frame_path) in enumerate(frames):
        x = (idx % columns) * (cell_w + gap)
        y = (idx // columns) * (cell_h + gap)
        try:
            with Image.open(frame_path) as frame:
                frame = frame.convert("RGB")
                frame.thumbnail((cell_w, cell_h), Image.Resampling.LANCZOS)
                px = x + (cell_w - frame.width) // 2
                py = y + (cell_h - frame.height) // 2
                sheet.paste(frame, (px, py))
        except Exception:
            draw.rectangle((x, y, x + cell_w - 1, y + cell_h - 1), outline=(80, 88, 96))
    dest = tmpdir / "contact-sheet.jpg"
    sheet.save(dest, "JPEG", quality=92, optimize=True)
    return dest


def _analysis_image_evidence(path: Path) -> dict:
    try:
        with Image.open(path) as img:
            return {
                "analysisImage": {
                    "width": img.width,
                    "height": img.height,
                    "maxSide": max(img.width, img.height),
                },
            }
    except Exception:
        return {}


def _video_input_frame_count(video_inputs: Any) -> int | None:
    try:
        if not video_inputs:
            return None
        first = video_inputs[0]
        shape = getattr(first, "shape", None)
        if shape and len(shape) >= 1:
            return int(shape[0])
        if isinstance(first, (list, tuple)):
            return len(first)
    except Exception:
        return None
    return None


def _chat_completion_text(output: Any) -> str:
    if isinstance(output, dict):
        choices = output.get("choices") or []
        if choices:
            choice = choices[0] or {}
            message = choice.get("message") or {}
            content = message.get("content")
            if isinstance(content, str):
                return content
            text = choice.get("text")
            if isinstance(text, str):
                return text
    return str(output or "")


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


def _clean_semantic_prompt(value: Any) -> str:
    prompt = str(value or "").strip()
    if not prompt:
        return DEFAULT_SEMANTIC_PROMPT
    if prompt in LEGACY_SEMANTIC_PROMPTS:
        return DEFAULT_SEMANTIC_PROMPT
    return prompt[:4000]


def _semantic_prompt(opts: AutoTagOptions) -> str:
    if not opts.semanticPromptEnabled:
        return DEFAULT_SEMANTIC_PROMPT
    return _clean_semantic_prompt(opts.semanticPrompt)


def _semantic_tag_limit(opts: AutoTagOptions) -> int:
    return max(1, min(int(opts.maxTags or 28), 60))


def _semantic_prompt_with_context(opts: AutoTagOptions, context: dict | None = None) -> str:
    prompt = _semantic_prompt(opts)
    if isinstance(context, dict) and context.get("mediaType") == "video":
        prompt += (
            "\n\nVideo input instruction:\n"
            "You are an expert video analysis model. The visual input represents a temporal video sequence, even if the "
            "runtime transports sampled frames internally. Analyze continuity, repeated actions, pose changes, and scene "
            "changes across time, but keep the output JSON schema unchanged. Focus on the important visible content: how "
            "the person or main subject looks, body/face/hair/eye attributes, clothing garments and materials, pose/action, "
            "setting, objects, text, and anything visually distinctive. Describe the media as a video or content, not as frames. "
            "For lewd, sketchy, unsafe, or nsfw video, explain exactly what is lewd: visible or emphasized body parts, "
            "nudity or partial nudity, transparent/tight/revealing garments, lingerie, swimwear, cleavage, underboob, "
            "sideboob, framing, explicit acts, and why the safety rating was selected. Do not rely only on suggestive pose. "
            "Do not describe the input as a grid, collage, contact sheet, slideshow, collection of images, "
            "series of frames, or frame set. Do not mention frame counts, timestamps, sampling, frame layout, or processor "
            "mechanics in tags or rationale."
        )
    compact = _compact_semantic_context(context)
    if compact:
        prompt += (
            "\n\nModel tag hints:\n"
            "Use these prior tagger results as visual grounding. They may contain noise, but if a specific animal type, "
            "ear, horn, tail, garment, clothing, color, pose, or visible object tag agrees with the image, prefer it over a generic guess. "
            "Do not use these hints to guess named characters, franchises, copyright/source tags, or identities.\n"
            f"{json.dumps(compact, ensure_ascii=False)}"
        )
    return prompt


def _compact_semantic_context(context: dict | None) -> dict:
    if not isinstance(context, dict):
        return {}
    compact: dict[str, Any] = {}
    hints = context.get("visualTagHints")
    if isinstance(hints, dict):
        visual = {
            "tags": _dedupe_tags(hints.get("tags") or [])[:40],
            "models": _dedupe_plain_strings(hints.get("models") or [])[:8],
        }
        visual = {key: value for key, value in visual.items() if value}
        if visual:
            compact["visualTagHints"] = visual
    if context.get("ocrText"):
        compact["ocrText"] = str(context.get("ocrText"))[:500]
    if context.get("transcript"):
        compact["transcript"] = str(context.get("transcript"))[:800]
    return compact


def _sanitize_qwen_semantic_payload(parsed: dict, context: dict | None = None) -> dict:
    if not isinstance(parsed, dict):
        return parsed
    blocked = _semantic_identity_hint_tags(context)
    tags = [normalize_tag(tag) for tag in parsed.get("tags", []) if normalize_tag(tag)]
    tags = [tag for tag in tags if tag not in blocked and not _is_frame_metadata_tag(tag)]
    parsed["tags"] = _dedupe_tags(tags)
    for key in ("rationale", "description", "summary"):
        if parsed.get(key):
            parsed[key] = _sanitize_semantic_rationale(str(parsed.get(key) or ""), blocked)
    return parsed


def _compact_semantic_raw_output(raw: str, parsed: dict) -> str:
    text = str(raw or "").strip()
    if not text:
        return text
    if len(text) <= 1400 and not _semantic_raw_is_repetitive(text):
        return text
    compact: dict[str, Any] = {
        "tags": [tag for tag in (parsed.get("tags") or []) if tag][:40],
    }
    safety = normalize_safety_label(parsed.get("safety"))
    if safety:
        compact["safety"] = safety
    rationale = str(
        parsed.get("rationale")
        or parsed.get("description")
        or parsed.get("summary")
        or ""
    ).strip()
    if rationale:
        compact["rationale"] = rationale[:900]
    else:
        compact["rationale"] = "Model output was compacted because it repeated tags or exceeded the preview limit."
    compact["compacted"] = True
    return json.dumps(compact, ensure_ascii=False)


def _semantic_raw_is_repetitive(text: str) -> bool:
    tags = [normalize_tag(value) for value in re.findall(r'"((?:\\.|[^"\\])*)"', str(text or ""))]
    tags = [tag for tag in tags if tag]
    if len(tags) < 40:
        return False
    unique = set(tags)
    if len(unique) / max(1, len(tags)) < 0.55:
        return True
    counts = Counter(tags)
    return any(count >= 8 for count in counts.values())


def _semantic_identity_hint_tags(context: dict | None) -> set[str]:
    if not isinstance(context, dict):
        return set()
    hints = context.get("visualTagHints")
    if not isinstance(hints, dict):
        return set()
    blocked = set()
    for key in ("characterTags", "copyrightTags"):
        for tag in hints.get(key) or []:
            norm = normalize_tag(tag)
            if norm:
                blocked.add(norm)
    return blocked


def _sanitize_semantic_rationale(text: str, blocked_tags: set[str] | None = None) -> str:
    out = str(text or "").strip()
    if not out:
        return out
    out = re.sub(
        r"\b(?:shown|depicted|presented)\s+in\s+a\s+series\s+of\s+frames\b",
        "shown in the video",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?video\s+frames?\s+(?:show|shows|depict|depicts)\b",
        "the video shows",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\bthe\s+(?:sampled\s+)?frames?\s+(?:show|shows|depict|depicts)\b",
        "the video shows",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\bacross\s+(?:the\s+)?(?:sampled\s+)?frames?\b",
        "throughout the video",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\bin\s+(?:the\s+)?(?:sampled\s+)?frames?\b",
        "in the video",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?(?:image|video|content)\s+(?:consists\s+of|contains|shows)\s+"
        r"(?:one|two|three|four|five|six|seven|eight|\d+)\s+(?:sampled\s+)?frames?\s+(?:showing|of)\b",
        "The video shows",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?(?:image|video|content)\s+is\s+(?:a\s+)?(?:series|grid|contact\s*sheet|compilation)\s+of\s+"
        r"(?:one|two|three|four|five|six|seven|eight|\d+)\s+(?:sampled\s+)?frames?\s+(?:showing|of)\b",
        "The video shows",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?(?:image|content)\s+is\s+a\s+(?:grid|collage|collection|set)\s+of\s+",
        "The video shows ",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?(?:image|content)\s+is\s+presented\s+as\s+(?:a\s+)?(?:grid|collage|collection|set)\s+of\s+[^.?!]+[.?!]\s*",
        "",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:across|in)\s+(?:the\s+)?(?:one|two|three|four|five|six|seven|eight|\d+)\s+(?:sampled\s+)?frames?\b",
        "in the video",
        out,
        flags=re.IGNORECASE,
    )
    sentences = re.split(r"(?<=[.!?])\s+", out)
    blocked_labels = {tag.replace("_", " ") for tag in (blocked_tags or set())}
    filtered = []
    identity_pattern = re.compile(
        r"\b(?:identified\s+as|character\s+is\s+identified|identity\s+is|franchise\s+is|copyright\s+is)\b",
        flags=re.IGNORECASE,
    )
    for sentence in sentences:
        lower = sentence.lower()
        if identity_pattern.search(sentence):
            continue
        if any(
            marker in lower
            for marker in (
                "frames are arranged",
                "arranged in a grid",
                "contact sheet",
                "sampled frame",
                "sampled frames",
                "frame labels",
                "series of frames",
                "frame set",
                "frame layout",
                "timestamp",
                "timestamps",
                "grid format",
                "slideshow format",
                "grid of",
                "collage of",
                "collection of selfies",
            )
        ):
            continue
        if blocked_labels and any(label and label in lower for label in blocked_labels):
            continue
        filtered.append(sentence)
    out = " ".join(part.strip() for part in filtered if part.strip())
    return re.sub(r"\s+", " ", out).strip()


def _add_visual_tag_hints(context: dict | None, results: list[AutoTagResult]) -> None:
    if context is None:
        return
    hints = context.setdefault("visualTagHints", {"tags": [], "characterTags": [], "copyrightTags": [], "models": []})
    if not isinstance(hints, dict):
        return
    for result in results:
        if not result or result.error:
            continue
        hints.setdefault("tags", []).extend(result.tags)
        hints.setdefault("characterTags", []).extend(result.character_tags)
        hints.setdefault("copyrightTags", []).extend(result.copyright_tags)
        if result.model:
            hints.setdefault("models", []).append(result.model)
    hints["tags"] = _dedupe_tags(hints.get("tags") or [])[:60]
    hints["characterTags"] = _dedupe_tags(hints.get("characterTags") or [])[:30]
    hints["copyrightTags"] = _dedupe_tags(hints.get("copyrightTags") or [])[:30]
    hints["models"] = _dedupe_plain_strings(hints.get("models") or [])[:10]


def _dedupe_plain_strings(values: list[Any]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value or "").strip()
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def validate_options(raw: dict) -> AutoTagOptions:
    data = asdict(default_options())
    data.update({k: v for k, v in (raw or {}).items() if k in data})
    for key in ("generalThreshold", "characterThreshold", "unsafeThreshold", "sketchyThreshold"):
        data[key] = min(1.0, max(0.0, float(data[key])))
    data["maxTags"] = min(200, max(1, int(data["maxTags"])))
    data["videoMaxFrames"] = min(8, max(1, int(data["videoMaxFrames"])))
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
            timeout=min(60.0, max(5.0, float(opts.remoteTimeoutSeconds))),
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


def _transformers_pipeline():
    try:
        from transformers.pipelines import pipeline as hf_pipeline  # type: ignore

        return hf_pipeline
    except Exception as direct_exc:  # noqa: BLE001
        try:
            from transformers import pipeline as hf_pipeline  # type: ignore

            return hf_pipeline
        except Exception as lazy_exc:  # noqa: BLE001
            raise ImportError(
                "transformers pipeline is unavailable. Reinstall the AI runtime so transformers, torch, "
                f"torchvision, and torchaudio are compatible. direct import: {direct_exc}; lazy import: {lazy_exc}"
            ) from lazy_exc


def _transformers_pipeline_available() -> bool:
    try:
        _transformers_pipeline()
        return True
    except Exception:
        return False


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
        "qwenDevice": _semantic_tagger_for_options(opts).device_info(),
        "semanticModelId": opts.semanticModelId,
        "remote": _remote_worker_status(opts),
        "huggingFaceTokenConfigured": bool(huggingface_token()),
        "dependencies": {
            "huggingface_hub": find_spec("huggingface_hub") is not None,
            "onnxruntime": find_spec("onnxruntime") is not None,
            "numpy": find_spec("numpy") is not None,
            "pillow": find_spec("PIL") is not None,
            "transformers": find_spec("transformers") is not None,
            "transformers_pipeline": _transformers_pipeline_available(),
            "torch": find_spec("torch") is not None,
            "qwen_vl_utils": find_spec("qwen_vl_utils") is not None,
            "llama_cpp": _llama_cpp_importable(),
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
        if not _load_job and not _load_queue:
            return None
        return _load_job_snapshot_locked()


def _tagger_for_model(model_id: str):
    if model_id == "wd":
        return _wd_tagger
    if model_id == "pixai":
        return _pixai_tagger
    if model_id == "camie":
        return _camie_tagger
    if model_id == "cl":
        return _cl_tagger
    if model_id == "ocr":
        return _ocr_tagger
    if model_id == "whisper":
        return _whisper_tagger
    if model_id == "qwen":
        return _qwen_tagger
    if model_id == "qwen_gguf_q4":
        return _qwen_gguf_q4_tagger
    if model_id == "qwen_gguf_q8":
        return _qwen_gguf_q8_tagger
    raise ValueError(f"Unknown model: {model_id}")


def _semantic_model_id(opts: AutoTagOptions) -> str:
    model_id = str(opts.semanticModelId or "qwen")
    return model_id if model_id in QWEN_SEMANTIC_MODEL_IDS else "qwen"


def _semantic_tagger_for_options(opts: AutoTagOptions):
    return _tagger_for_model(_semantic_model_id(opts))


def start_model_load(model_id: str = "wd") -> dict:
    tagger = _tagger_for_model(model_id)

    global _load_job, _load_worker
    with _load_lock:
        if tagger.is_loaded():
            _load_job = _new_load_job(model_id, status="completed", progress=100, message="Model weights already loaded")
            return _load_job_snapshot_locked()
        running = _load_job if _load_job and _load_job.get("status") in {"queued", "running"} else None
        if running and running.get("modelId") == model_id:
            return _load_job_snapshot_locked()
        if model_id in _load_queue:
            return _load_job_snapshot_locked()
        if running:
            # A different model is loading. Queue this one instead of handing
            # back the in-flight job, which used to leave the UI polling a load
            # that was never going to happen.
            _load_queue.append(model_id)
            return _load_job_snapshot_locked()
        _load_queue.append(model_id)
        if _load_worker is None or not _load_worker.is_alive():
            _load_worker = threading.Thread(target=_run_model_load_queue, daemon=True)
            _load_worker.start()
        return _load_job_snapshot_locked()


def _load_job_snapshot_locked() -> dict:
    """Current load job plus anything waiting behind it. Caller holds _load_lock."""
    snapshot = json.loads(json.dumps(_load_job)) if _load_job else {}
    snapshot["queued"] = list(_load_queue)
    return snapshot


def _run_model_load_queue() -> None:
    global _load_job
    while True:
        with _load_lock:
            if not _load_queue:
                return
            model_id = _load_queue.pop(0)
            _load_job = _new_load_job(model_id, status="queued", progress=0, message="Queued model weight load")
            job_id = _load_job["id"]
        _run_model_load_job(job_id, model_id)


def unload_model(model_id: str) -> dict:
    tagger = _tagger_for_model(model_id)
    # Freeing weights out from under a running inference crashes the process.
    with _gpu_work_lock:
        was_loaded = bool(tagger.unload())
    return {
        "modelId": model_id,
        "model": MODEL_REGISTRY[model_id]["name"],
        "unloaded": was_loaded,
        "loaded": bool(tagger.is_loaded()),
        "models": model_statuses(),
    }


def delete_model_cache(model_id: str) -> dict:
    if model_id not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model: {model_id}")
    with _download_lock:
        if _download_job and _download_job.get("status") in {"queued", "running"}:
            raise RuntimeError("Wait for the active model download to finish before deleting model files")

    tagger = _tagger_for_model(model_id)
    was_loaded = bool(tagger.unload())
    meta = MODEL_REGISTRY[model_id]
    if meta.get("storage") == "local_files":
        cache_path = _qwen_gguf_dir(model_id)
        deleted_paths = []
        if cache_path.exists():
            shutil.rmtree(cache_path)
            deleted_paths.append(str(cache_path))
        return {
            "modelId": model_id,
            "model": meta["name"],
            "deleted": bool(deleted_paths),
            "unloaded": was_loaded,
            "cachePath": str(cache_path),
            "deletedPaths": deleted_paths,
            "models": model_statuses(),
        }

    repo_id = str(meta["repoId"])
    cache_paths = _model_cache_paths(repo_id)

    deleted_paths = []
    for cache_path in cache_paths:
        if not cache_path.exists():
            continue
        if cache_path.is_dir():
            shutil.rmtree(cache_path)
        else:
            cache_path.unlink()
        deleted_paths.append(str(cache_path))

    return {
        "modelId": model_id,
        "model": meta["name"],
        "deleted": bool(deleted_paths),
        "unloaded": was_loaded,
        "cachePath": deleted_paths[0] if deleted_paths else str(_repo_cache_path(repo_id).resolve()),
        "deletedPaths": deleted_paths,
        "models": model_statuses(),
    }


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


def _new_load_job(model_id: str, *, status: str, progress: int, message: str) -> dict:
    now = time.time()
    estimates = {
        "wd": 20,
        "pixai": 15,
        "camie": 30,
        "cl": 45,
        "ocr": 25,
        "whisper": 25,
        "qwen": 90,
        "qwen_gguf_q4": 45,
        "qwen_gguf_q8": 60,
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
        # Wait for any in-flight inference: allocating a second model's weights
        # while a tag run is mid-image is how this used to OOM the process.
        if not _gpu_work_lock.acquire(blocking=False):
            progress("waiting", 5, "Waiting for the current tagging run to finish")
            _gpu_work_lock.acquire()
        try:
            if model_id == "wd":
                _wd_tagger.ensure_loaded(progress=progress)
            else:
                progress("load_weights", 15, f"Loading {MODEL_REGISTRY[model_id]['name']} weights into memory")
                if model_id in QWEN_SEMANTIC_MODEL_IDS:
                    _tagger_for_model(model_id).ensure_loaded(load_options().torchDevice)
                else:
                    _tagger_for_model(model_id).ensure_loaded()
                progress("ready", 100, "Model weights loaded")
        finally:
            _gpu_work_lock.release()
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
    if model_id == "pixai":
        return list(_pixai_tagger._providers)
    if model_id == "camie":
        return list(_camie_tagger._providers)
    if model_id == "cl":
        return list(_cl_tagger._providers)
    if model_id in {"qwen_gguf_q4", "qwen_gguf_q8"} and _llama_cpp_importable():
        return ["llama.cpp"]
    return []


def runtime_available(model_id: str) -> bool:
    if model_id in {"wd", "pixai", "camie", "cl"}:
        return bool(_onnx_runtime_info().get("available")) and find_spec("numpy") is not None
    if model_id in {"ocr", "whisper"}:
        return find_spec("transformers") is not None and find_spec("torch") is not None
    if model_id == "qwen":
        return (
            find_spec("transformers") is not None
            and find_spec("torch") is not None
            and find_spec("qwen_vl_utils") is not None
        )
    if model_id in {"qwen_gguf_q4", "qwen_gguf_q8"}:
        return _llama_cpp_importable()
    return False


def _prepare_llama_cpp_runtime() -> None:
    if os.name != "nt":
        return
    candidates: list[Path] = []
    llama_spec = find_spec("llama_cpp")
    if llama_spec and llama_spec.origin:
        site_packages = Path(llama_spec.origin).resolve().parents[1]
        candidates.extend([site_packages / "llama_cpp" / "lib", site_packages / "torch" / "lib"])
        nvidia_root = site_packages / "nvidia"
        if nvidia_root.exists():
            candidates.extend(path for path in nvidia_root.rglob("bin") if path.is_dir())
    torch_spec = find_spec("torch")
    if torch_spec and torch_spec.origin:
        candidates.append(Path(torch_spec.origin).resolve().parent / "lib")

    existing_path = os.environ.get("PATH", "")
    existing_parts = [part for part in existing_path.split(os.pathsep) if part]
    prepend: list[str] = []
    for path in candidates:
        if not path.exists():
            continue
        text = str(path)
        if text not in existing_parts and text not in prepend:
            prepend.append(text)
        if hasattr(os, "add_dll_directory"):
            try:
                _LLAMA_DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(text))
            except OSError:
                pass
    if prepend:
        os.environ["PATH"] = os.pathsep.join([*prepend, *existing_parts])

    llama_lib = next((path for path in candidates if path.name == "lib" and path.parent.name == "llama_cpp"), None)
    if not llama_lib:
        return
    for name in ("ggml-base.dll", "ggml-cpu.dll", "ggml-cuda.dll", "ggml.dll", "llama.dll", "mtmd.dll"):
        path = llama_lib / name
        if not path.exists():
            continue
        try:
            _LLAMA_PRELOAD_HANDLES.append(ctypes.CDLL(str(path)))
        except Exception as exc:  # noqa: BLE001
            logger.debug("Unable to preload llama.cpp DLL %s: %s", path, exc)


def _llama_cpp_importable() -> bool:
    if find_spec("llama_cpp") is None:
        return False
    try:
        _prepare_llama_cpp_runtime()
        importlib.import_module("llama_cpp")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.debug("llama_cpp is installed but not importable yet: %s", exc)
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
            if job.get("cancelRequested") or job.get("status") == "cancelling":
                raise DownloadCancelled("Model download cancelled")
            model = job["models"].get(self._model_id)
            if not model:
                return
            model["current"] = self.desc or model.get("current") or ""
            if self.unit.upper().startswith("B"):
                if self.total > 0:
                    model["bytesTotal"] = max(int(model.get("bytesTotal") or 0), self.total)
                model["bytesDownloaded"] = max(int(model.get("bytesDownloaded") or 0), self.n)
            model["updatedAt"] = time.time()


# Deliberately process-global rather than thread-local: snapshot_download fans
# per-file progress bars out to worker threads, and a thread-local context would
# leave every one of them unable to find the job, so byte progress never moved.
# Only one download job runs at a time (start_model_download enforces it).
_download_context: dict[str, str | None] = {"job_id": None, "model_id": None}


def _active_job_id() -> str | None:
    return _download_context.get("job_id")


def _active_model_id() -> str | None:
    return _download_context.get("model_id")


def current_download_job() -> dict | None:
    with _download_lock:
        _reconcile_download_job_locked()
        return json.loads(json.dumps(_download_job)) if _download_job else None


def cancel_model_download() -> dict:
    with _download_lock:
        if not _download_job or _download_job.get("status") not in _DOWNLOAD_ACTIVE_STATUSES:
            raise RuntimeError("No active model download is running")
        _refresh_download_row_progress_locked()
        _download_job["status"] = "cancelling"
        _download_job["cancelRequested"] = True
        _download_job["cancelRequestedAt"] = time.time()
        _download_job["updatedAt"] = time.time()
        has_active_download = False
        for row in _download_job.get("models", {}).values():
            if row.get("status") == "running":
                row["status"] = "cancelling"
                row["current"] = "Cancelling download"
                row["updatedAt"] = time.time()
                has_active_download = True
            elif row.get("status") in {"queued", "cancelling"}:
                row["status"] = "cancelled"
                row["current"] = "Cancelled before download started"
                row["updatedAt"] = time.time()
        if not has_active_download:
            _mark_download_job_cancelled_locked()
        return json.loads(json.dumps(_download_job))


def _refresh_download_row_progress_locked() -> None:
    if not _download_job:
        return
    for model_id in list(_download_job.get("modelIds") or []):
        row = _download_job.get("models", {}).get(model_id)
        if not row or row.get("status") in _DOWNLOAD_TERMINAL_STATUSES:
            continue
        downloaded, total = _local_file_download_progress(model_id)
        if total:
            previous = int(row.get("bytesDownloaded") or 0)
            row["bytesTotal"] = max(int(row.get("bytesTotal") or 0), total)
            row["bytesDownloaded"] = max(previous, downloaded)
            if downloaded > previous:
                row["updatedAt"] = time.time()
                _download_job["updatedAt"] = time.time()
            if row.get("status") == "running":
                row["current"] = "Downloading local model files"


def _reconcile_download_job_locked() -> None:
    if not _download_job or _download_job.get("status") not in _DOWNLOAD_ACTIVE_STATUSES:
        return

    _refresh_download_row_progress_locked()

    if _download_job.get("cancelRequested"):
        has_active_download = False
        for row in _download_job.get("models", {}).values():
            status = row.get("status")
            if status == "queued":
                row["status"] = "cancelled"
                row["current"] = "Cancelled before download started"
                row["updatedAt"] = time.time()
            elif status in {"running", "cancelling"}:
                has_active_download = True
        if not has_active_download:
            _mark_download_job_cancelled_locked()
        return

    changed = False
    for model_id in list(_download_job.get("modelIds") or []):
        row = _download_job["models"].get(model_id)
        if not row or row.get("status") in _DOWNLOAD_TERMINAL_STATUSES:
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
    runtime_job = _ensure_download_runtime(model_ids)

    global _download_job
    with _download_lock:
        _reconcile_download_job_locked()
        if _download_job and _download_job.get("status") in _DOWNLOAD_ACTIVE_STATUSES:
            # Queue onto the running job rather than rejecting: the user should
            # be able to line several models up and walk away.
            if _download_job.get("cancelRequested"):
                raise RuntimeError("The current model download is being cancelled")
            added = _enqueue_download_models_locked(model_ids)
            snapshot = json.loads(json.dumps(_download_job))
            if runtime_job:
                snapshot["runtimeInstallJob"] = runtime_job
            snapshot["queued"] = added
            return snapshot
        job_id = str(uuid.uuid4())
        _download_job = {
            "id": job_id,
            "status": "queued",
            "cancelRequested": False,
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
                    "bytesTotal": _expected_download_total(model_id),
                    "current": "",
                    "error": None,
                    "updatedAt": time.time(),
                }
                for model_id in model_ids
            },
        }
        snapshot = json.loads(json.dumps(_download_job))
    if runtime_job:
        snapshot["runtimeInstallJob"] = runtime_job

    thread = threading.Thread(target=_run_model_download_job, args=(job_id,), daemon=True)
    thread.start()
    return snapshot


def _enqueue_download_models_locked(model_ids: list[str]) -> list[str]:
    """Add models to the running download job. Caller holds _download_lock."""
    if not _download_job:
        return []
    added: list[str] = []
    for model_id in model_ids:
        row = _download_job["models"].get(model_id)
        # Re-queue anything that is not already done or in flight, so retrying a
        # failed model is just another download click.
        if row and row.get("status") in {"queued", "running", "completed"}:
            continue
        if row and row.get("status") == "failed":
            _download_job["failed"] = max(0, int(_download_job.get("failed") or 0) - 1)
        _download_job["models"][model_id] = {
            "id": model_id,
            "name": MODEL_REGISTRY[model_id]["name"],
            "repoId": MODEL_REGISTRY[model_id]["repoId"],
            "status": "queued",
            "bytesDownloaded": 0,
            "bytesTotal": _expected_download_total(model_id),
            "current": "",
            "error": None,
            "updatedAt": time.time(),
        }
        if model_id not in _download_job["modelIds"]:
            _download_job["modelIds"].append(model_id)
        added.append(model_id)
    if added:
        _download_job["total"] = len(_download_job["modelIds"])
        _download_job["updatedAt"] = time.time()
    return added


def _ensure_download_runtime(model_ids: list[str]) -> dict | None:
    if not any(model_id in {"qwen_gguf_q4", "qwen_gguf_q8"} for model_id in model_ids):
        return None
    if _llama_cpp_importable():
        return None
    try:
        from . import ai_runtime_installer

        return ai_runtime_installer.start_llama_cpp_install()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unable to start llama.cpp runtime install for GGUF download: %s", exc)
        return {"status": "failed", "error": str(exc), "message": "Unable to start llama.cpp runtime install"}


def download_all_model_ids() -> list[str]:
    opts = load_options()
    selected_semantic = _semantic_model_id(opts)
    ids: list[str] = []
    for model_id, meta in MODEL_REGISTRY.items():
        if meta.get("role") == "semantic":
            if model_id == selected_semantic:
                ids.append(model_id)
            continue
        if meta.get("downloadAll", True):
            ids.append(model_id)
    return ids


def _run_model_download_job(job_id: str) -> None:
    from huggingface_hub import snapshot_download  # type: ignore

    global _download_job
    token = huggingface_token()
    with _download_lock:
        if _download_job and _download_job.get("id") == job_id:
            _download_job["status"] = "running"
            _download_job["updatedAt"] = time.time()

    # Re-read the pending list every pass: start_model_download() can append
    # more models while this job is already running.
    while True:
        with _download_lock:
            if not _download_job or _download_job.get("id") != job_id:
                return
            if _download_job.get("cancelRequested"):
                _mark_download_job_cancelled_locked()
                return
            model_id = next(
                (
                    candidate
                    for candidate in _download_job["modelIds"]
                    if _download_job["models"].get(candidate, {}).get("status") == "queued"
                ),
                None,
            )
            if model_id is None:
                # Finish under the same lock the enqueuer uses, so a model added
                # right now either lands in this job (and is picked up above) or
                # sees a finished job and starts a fresh one. Never both.
                _download_job["status"] = "failed" if _download_job["failed"] else "completed"
                _download_job["updatedAt"] = time.time()
                _download_context["job_id"] = None
                _download_context["model_id"] = None
                return
        meta = MODEL_REGISTRY[model_id]
        _download_context["job_id"] = job_id
        _download_context["model_id"] = model_id
        with _download_lock:
            if not _download_job or _download_job.get("id") != job_id:
                return
            row = _download_job["models"][model_id]
            row["status"] = "running"
            row["current"] = "Starting download"
            row["updatedAt"] = time.time()
            _download_job["updatedAt"] = time.time()
        try:
            kwargs = {
                "repo_id": str(meta["repoId"]),
                "token": huggingface_token(),
                "allow_patterns": meta.get("allowPatterns"),
                "tqdm_class": _ProgressTqdm,
            }
            if meta.get("storage") == "local_files":
                local_dir = _qwen_gguf_dir(model_id)
                local_dir.mkdir(parents=True, exist_ok=True)
                kwargs["local_dir"] = str(local_dir)
                kwargs["max_workers"] = 1
            else:
                kwargs["cache_dir"] = _hf_cache_dir()
            with _download_lock:
                if _download_job and _download_job.get("id") == job_id:
                    row = _download_job["models"][model_id]
                    downloaded, total = _local_file_download_progress(model_id)
                    row["bytesDownloaded"] = max(int(row.get("bytesDownloaded") or 0), downloaded)
                    row["bytesTotal"] = max(int(row.get("bytesTotal") or 0), total)
                    if total:
                        row["current"] = "Fetching local model files"
                    row["updatedAt"] = time.time()
            snapshot_download(**kwargs)
            cache = model_cache_status(model_id)
            with _download_lock:
                if not _download_job or _download_job.get("id") != job_id:
                    return
                row = _download_job["models"][model_id]
                if _download_job.get("cancelRequested"):
                    row["status"] = "cancelled"
                    row["current"] = "Cancelled"
                    row["error"] = None
                    row["updatedAt"] = time.time()
                    _mark_download_job_cancelled_locked()
                    return
                row["status"] = "completed"
                row["downloaded"] = cache["downloaded"]
                row["files"] = cache["files"]
                row["current"] = "Downloaded"
                row["updatedAt"] = time.time()
                _download_job["completed"] += 1
                _download_job["updatedAt"] = time.time()
        except DownloadCancelled as exc:
            with _download_lock:
                if _download_job and _download_job.get("id") == job_id:
                    row = _download_job["models"].get(model_id)
                    if row:
                        row["status"] = "cancelled"
                        row["current"] = "Cancelled"
                        row["error"] = None
                        row["updatedAt"] = time.time()
                    _mark_download_job_cancelled_locked(str(exc))
            return
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
        finally:
            _download_context["job_id"] = None
            _download_context["model_id"] = None


def _mark_download_job_cancelled_locked(message: str = "Model download cancelled") -> None:
    if not _download_job:
        return
    _download_job["status"] = "cancelled"
    _download_job["error"] = message
    _download_job["updatedAt"] = time.time()
    for row in _download_job.get("models", {}).values():
        if row.get("status") in {"queued", "running", "cancelling"}:
            row["status"] = "cancelled"
            row["current"] = "Cancelled"
            row["updatedAt"] = time.time()


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
        # Remote work happens on the worker's GPU, so it must not queue behind
        # the local lock.
        return _tag_media_remote(path, opts)
    with _gpu_work_lock:
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
    context: dict = {}
    if opts.wdEnabled:
        unavailable = _unavailable_model_result("wd")
        wd = unavailable or _time_result("wd", lambda: _wd_tagger.tag_image(path, opts))
        results.append(wd)
        _add_visual_tag_hints(context, [wd])
    results.extend(_optional_image_results(path, opts, context=context))
    if not results:
        return AutoTagResult(enabled=True, error="no_models_enabled")
    return _combine_results(results)


def _optional_image_results(
    path: Path,
    opts: AutoTagOptions,
    context: dict | None = None,
    *,
    include_qwen: bool = True,
) -> list[AutoTagResult]:
    results: list[AutoTagResult] = []
    if opts.pixaiEnabled:
        pixai = _unavailable_model_result("pixai") or _run_optional("pixai", lambda: _pixai_tagger.tag_image(path, opts))
        results.append(pixai)
        _add_visual_tag_hints(context, [pixai])
    if opts.characterModelEnabled:
        camie = _unavailable_model_result("camie") or _run_optional("camie", lambda: _camie_tagger.tag_image(path, opts))
        results.append(camie)
        _add_visual_tag_hints(context, [camie])
    if opts.clEnabled:
        cl = _unavailable_model_result("cl") or _run_optional("cl", lambda: _cl_tagger.tag_image(path, opts))
        results.append(cl)
        _add_visual_tag_hints(context, [cl])
    if opts.ocrEnabled:
        ocr = _unavailable_model_result("ocr") or _run_optional("ocr", lambda: _ocr_tagger.read_image(path))
        results.append(ocr)
        if context is not None and ocr.evidence.get("text"):
            context["ocrText"] = ocr.evidence.get("text")
    if include_qwen and (opts.qwenEnabled or opts.semanticPoliticalEnabled):
        model_id = _semantic_model_id(opts)
        tagger = _tagger_for_model(model_id)
        results.append(
            _unavailable_model_result(model_id)
            or _run_optional(model_id, lambda: _analyze_qwen_image(tagger, path, context=context, opts=opts))
        )
    return results


def _tag_video_with_enrichers(path: Path, opts: AutoTagOptions) -> AutoTagResult:
    base = _time_result("wd", lambda: _tag_video(path, opts)) if opts.wdEnabled else _tag_video(path, opts)
    results = [base]
    context: dict = {"mediaType": "video"}
    _add_visual_tag_hints(context, [base])
    if opts.whisperEnabled:
        whisper = _unavailable_model_result("whisper") or _run_optional("whisper", lambda: _whisper_tagger.transcribe_video(path, opts))
        results.append(whisper)
        if whisper.evidence.get("transcript"):
            context["transcript"] = whisper.evidence.get("transcript")
    visual_enrichers = opts.pixaiEnabled or opts.characterModelEnabled or opts.clEnabled or opts.ocrEnabled
    qwen_enricher = opts.qwenEnabled or opts.semanticPoliticalEnabled
    if visual_enrichers:
        frames = _sample_video_frames(path, opts, frame_count=opts.videoMaxFrames, prefix="visual-frames-")
        if frames:
            try:
                visual_result = _tag_video_frames_with_image_enrichers(frames, opts, context=context)
                results.append(visual_result)
                _add_visual_tag_hints(context, [visual_result])
            finally:
                shutil.rmtree(frames[0][1].parent, ignore_errors=True)
    if qwen_enricher:
        model_id = _semantic_model_id(opts)
        tagger = _tagger_for_model(model_id)
        unavailable = _unavailable_model_result(model_id)
        if unavailable:
            results.append(unavailable)
        elif opts.qwenVideoUseFps and hasattr(tagger, "analyze_video"):
            results.append(_run_optional(model_id, lambda: tagger.analyze_video(path, context=context, opts=opts)))
        else:
            frames, qwen_mode = _sample_qwen_video_frames(path, opts)
            if frames:
                try:
                    results.append(_run_optional(model_id, lambda: _analyze_qwen_video_frames(tagger, frames, context=context, opts=opts, mode=qwen_mode)))
                finally:
                    shutil.rmtree(frames[0][1].parent, ignore_errors=True)
            else:
                results.append(AutoTagResult(enabled=True, model=str(MODEL_REGISTRY[model_id]["name"]), error="no_video_frames"))
    return _combine_results(results)


def _run_optional(model_id: str, fn) -> AutoTagResult:
    started = time.perf_counter()
    try:
        return _set_result_duration(fn(), started)
    except ImportError as exc:
        return AutoTagResult(
            enabled=True,
            model=str(MODEL_REGISTRY[model_id]["name"]),
            error=f"missing_runtime_dependency: {exc}",
            evidence={"kind": model_id, "error": f"missing_runtime_dependency: {exc}"},
            duration_ms=_elapsed_ms(started),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s pipeline failed: %s", model_id, exc)
        return AutoTagResult(
            enabled=True,
            model=str(MODEL_REGISTRY[model_id]["name"]),
            error=str(exc),
            evidence={"kind": model_id, "error": str(exc)},
            duration_ms=_elapsed_ms(started),
        )


def _time_result(model_id: str, fn) -> AutoTagResult:
    started = time.perf_counter()
    try:
        return _set_result_duration(fn(), started)
    except Exception:
        raise


def _set_result_duration(result: AutoTagResult, started: float) -> AutoTagResult:
    result.duration_ms = _elapsed_ms(started)
    if isinstance(result.evidence, dict):
        result.evidence.setdefault("durationMs", result.duration_ms)
    return result


def _elapsed_ms(started: float) -> int:
    return max(0, int(round((time.perf_counter() - started) * 1000)))


def _unavailable_model_result(model_id: str) -> AutoTagResult | None:
    meta = MODEL_REGISTRY[model_id]
    model_name = str(meta["name"])
    if not runtime_available(model_id):
        message = "missing_runtime_dependency"
    elif not model_cache_status(model_id).get("downloaded"):
        message = "model_not_downloaded"
    else:
        return None
    return AutoTagResult(
        enabled=True,
        model=model_name,
        error=message,
        evidence={
            "kind": model_id,
            "error": message,
            "repoId": meta["repoId"],
            "action": "download_model" if message == "model_not_downloaded" else "install_ai_runtime",
        },
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
            "durationMs": result.duration_ms,
            "evidence": result.evidence,
        })
        if result.error:
            errors.append(f"{result.model}: {result.error}")
    combined.tags = _dedupe_tags(combined.tags)
    combined.character_tags = _dedupe_tags(combined.character_tags)
    combined.copyright_tags = _dedupe_tags(combined.copyright_tags)
    combined.model = "+".join([result.model for result in results if result and result.model])
    combined.duration_ms = sum(int(result.duration_ms or 0) for result in results if result)
    combined.evidence = {"models": evidence_models, "durationMs": combined.duration_ms}
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
    suggested = normalize_safety_label(suggested)
    if not opts.applySafety or not suggested:
        return current
    rank = {"safe": 0, "sketchy": 1, "unsafe": 2}
    if opts.neverDowngradeSafety and rank.get(suggested, 0) < rank.get(current, 0):
        return current
    return suggested if rank.get(suggested, 0) > rank.get(current, 0) else current


def normalize_safety_label(value: Any) -> str | None:
    label = normalize_tag(str(value or ""))
    if not label:
        return None
    if label in {"safe", "general", "sfw"}:
        return "safe"
    if label in {
        "sketchy",
        "questionable",
        "sensitive",
        "suggestive",
        "sexually_suggestive",
        "partial_nudity",
        "partial_nude",
        "revealing",
    }:
        return "sketchy"
    if label in {
        "unsafe",
        "explicit",
        "nsfw",
        "nude",
        "nudity",
        "naked",
        "sexual",
        "porn",
        "pornographic",
        "adult",
        "adult_erotic",
        "explicit_sexual",
        "explicit_nsfw_content",
    }:
        return "unsafe"
    return None


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
        if norm and not _is_frame_metadata_tag(norm) and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def _is_frame_metadata_tag(tag: str) -> bool:
    normalized = normalize_tag(tag)
    if normalized in {"frame", "frames", "sampled_frame", "sampled_frames", "timestamp", "timestamps", "grid", "collage", "contact_sheet", "photo_collage", "image_grid"}:
        return True
    if re.fullmatch(r"frame_\d+", normalized):
        return True
    if re.fullmatch(r"\d+_frames?", normalized):
        return True
    if re.fullmatch(r"(?:one|two|three|four|five|six|seven|eight)_frames?", normalized):
        return True
    if re.fullmatch(r"t_\d+(?:[._]\d+)?s?", normalized):
        return True
    return False


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


def _cached_file_by_suffix(files: dict, suffix: str) -> str | None:
    suffix = suffix.lower()
    for name, meta in sorted(files.items()):
        path = meta.get("path") if isinstance(meta, dict) else None
        if meta.get("downloaded") and str(name).lower().endswith(suffix) and path:
            return str(path)
    return None


def _cached_tag_metadata_file(files: dict) -> str | None:
    preferred = (
        "selected_tags.csv",
        "tags.csv",
        "tag_names.csv",
        "classes.csv",
        "labels.csv",
        "tags.json",
        "labels.json",
        "tags.txt",
        "labels.txt",
    )
    for filename in preferred:
        path = _cached_file(files, filename)
        if path:
            return path
    for name, meta in sorted(files.items()):
        if not isinstance(meta, dict) or not meta.get("downloaded"):
            continue
        path = meta.get("path")
        lower = str(name).lower()
        if path and lower.endswith((".csv", ".json", ".txt")) and any(token in lower for token in ("tag", "label", "class")):
            return str(path)
    return None


def _onnx_input_image_size(session, default: int = 448) -> int:
    try:
        shape = list(session.get_inputs()[0].shape or [])
    except Exception:
        return default
    ints = [int(value) for value in shape if isinstance(value, int) and value > 8]
    if not ints:
        return default
    return int(max(ints))


def _generic_onnx_image_tensor(path: Path, image_size: int, shape):
    import numpy as np  # type: ignore

    with Image.open(path) as image:
        image = image.convert("RGB")
        image = _letterbox(image, image_size)
        arr = np.asarray(image, dtype=np.float32)

    shape_list = list(shape or [])
    if len(shape_list) >= 4 and shape_list[1] == 3:
        arr = np.transpose(arr, (2, 0, 1))[None, ...]
    else:
        arr = arr[None, ...]
    return arr.astype(np.float32)


def _flatten_onnx_scores(outputs, np):
    arrays = [np.asarray(output) for output in outputs]
    arrays = [array for array in arrays if array.size]
    if not arrays:
        return np.asarray([], dtype=np.float32)
    array = max(arrays, key=lambda item: item.size)
    return np.asarray(array).reshape(-1)


def _read_pixai_tag_rows(path: Path) -> list[tuple[str, str]]:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with open(path, encoding="utf-8-sig", newline="") as fh:
            return _read_tag_rows_from_csv(fh)
    if suffix == ".json":
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
        return _read_tag_rows_from_json(data)
    with open(path, encoding="utf-8-sig") as fh:
        return [(line.strip(), "general") for line in fh if normalize_tag(line)]


def _read_tag_rows_from_csv(fh) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    reader = csv.DictReader(fh)
    if not reader.fieldnames:
        return rows
    lower_fields = {field.lower(): field for field in reader.fieldnames}
    name_key = next((lower_fields[key] for key in ("name", "tag", "label", "class", "tag_name") if key in lower_fields), reader.fieldnames[0])
    category_key = next((lower_fields[key] for key in ("category", "type", "kind") if key in lower_fields), None)
    for row in reader:
        name = str(row.get(name_key) or "").strip()
        if not normalize_tag(name):
            continue
        rows.append((name, _normalize_tagger_category(row.get(category_key) if category_key else None)))
    return rows


def _read_tag_rows_from_json(data) -> list[tuple[str, str]]:
    if isinstance(data, dict):
        for key in ("tags", "labels", "classes", "selected_tags"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            if all(isinstance(key, str) for key in data.keys()):
                return [(str(value), "general") for _, value in sorted(data.items()) if normalize_tag(str(value))]
    if not isinstance(data, list):
        return []
    rows = []
    for item in data:
        if isinstance(item, str):
            rows.append((item, "general"))
        elif isinstance(item, dict):
            name = item.get("name") or item.get("tag") or item.get("label") or item.get("class")
            if normalize_tag(str(name or "")):
                rows.append((str(name), _normalize_tagger_category(item.get("category") or item.get("type") or item.get("kind"))))
    return rows


def _normalize_tagger_category(value) -> str:
    text = normalize_tag(str(value or "general"))
    if text in {"0", "general", "tag"}:
        return "general"
    if text in {"1", "artist"}:
        return "artist"
    if text in {"3", "copyright", "source"}:
        return "copyright"
    if text in {"4", "character"}:
        return "character"
    if text in {"9", "rating", "safety"}:
        return "rating"
    return text or "general"


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


def _siglip_tensor(path: Path, image_size: int):
    """SigLIP2 preprocessing: square resize, scale to [0,1], normalize mean=std=0.5."""
    import numpy as np  # type: ignore

    with Image.open(path) as img:
        img = img.convert("RGB")
        resized = img.resize((image_size, image_size), Image.BICUBIC)
        arr = np.asarray(resized, dtype=np.float32) / 255.0
    arr = (arr - 0.5) / 0.5
    return np.transpose(arr, (2, 0, 1))[None, ...].astype(np.float32)


def _cl_vocab_section(vocab: dict, key: str) -> dict:
    """Read a vocabulary section, tolerating version-prefixed keys like 'v2_01a/idx_to_tag'."""
    section = vocab.get(key)
    if isinstance(section, dict):
        return section
    suffix = f"/{key}"
    for name, value in vocab.items():
        if isinstance(name, str) and name.endswith(suffix) and isinstance(value, dict):
            return value
    return {}


def _read_cl_vocabulary(path: Path) -> tuple[dict[int, str], dict[str, str]]:
    with open(path, encoding="utf-8") as fh:
        vocab = json.load(fh)

    idx_to_tag: dict[int, str] = {}
    for key, value in _cl_vocab_section(vocab, "idx_to_tag").items():
        try:
            idx_to_tag[int(key)] = str(value)
        except (TypeError, ValueError):
            continue

    tag_to_category: dict[str, str] = {}
    for tag, category in _cl_vocab_section(vocab, "tag_to_category").items():
        normalized = str(category or "").strip().lower()
        if normalized in {"", "unknown"}:
            continue
        # Vocabularies exported before the RATING_TAGS convention fix file the
        # bare rating/quality words under "General"; reclassify them here so they
        # do not leak into the general tag list.
        word = str(tag).strip().lower().replace("_", " ")
        if word in CL_RATING_WORDS:
            normalized = "rating"
        elif word in CL_QUALITY_WORDS:
            normalized = "quality"
        tag_to_category[str(tag)] = normalized
    return idx_to_tag, tag_to_category


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
        return _semantic_fallback_payload(raw)
    if not isinstance(data, dict):
        return _semantic_fallback_payload(raw)
    if not data.get("rationale") and data.get("description"):
        data["rationale"] = data.get("description")
    if not data.get("safety") and data.get("safety_classification"):
        safety = normalize_safety_label(data.get("safety_classification"))
        if safety:
            data["safety"] = safety
    tags = data.get("tags") or data.get("keywords") or data.get("search_tags") or []
    if isinstance(tags, str):
        tags = [tags]
    tags = tags if isinstance(tags, list) else []
    semantic_text = " ".join(
        str(value or "")
        for value in (
            raw,
            data.get("rationale"),
            data.get("description"),
            data.get("caption"),
            data.get("summary"),
            data.get("scene"),
            data.get("safety_reason"),
            data.get("raw"),
        )
    )
    if not tags:
        tags = _semantic_tags_from_text(semantic_text)
    tags = _dedupe_tags([
        *tags,
        *_semantic_pose_action_tags_from_text(semantic_text),
        *_semantic_symbol_tags_from_text(semantic_text),
    ])
    data["tags"] = tags
    return data


def _semantic_fallback_payload(raw: str) -> dict:
    tags = _dedupe_tags([
        *_semantic_tag_list_from_text(raw),
        *_semantic_tags_from_text(raw),
        *_semantic_symbol_tags_from_text(raw),
    ])
    payload = {"tags": tags, "raw": raw}
    safety = _semantic_safety_from_text(raw)
    if safety:
        payload["safety"] = safety
    return payload


def _semantic_tag_list_from_text(text: str) -> list[str]:
    match = re.search(r'"(?:tags|keywords|search_tags)"\s*:\s*\[([\s\S]*?)(?:\]|\n\s*"(?:safety|rationale|description|summary)"\s*:|$)', str(text or ""), flags=re.IGNORECASE)
    if not match:
        return []
    return [value for value in re.findall(r'"((?:\\.|[^"\\])*)"', match.group(1)) if value.strip()]


def _semantic_safety_from_text(text: str) -> str | None:
    match = re.search(r'"(?:safety|safety_classification)"\s*:\s*"([^"]+)"', str(text or ""), flags=re.IGNORECASE)
    return normalize_safety_label(match.group(1)) if match else None


def _semantic_symbol_tags_from_text(text: str) -> list[str]:
    haystack = str(text or "").lower()

    def present(pattern: str) -> bool:
        return re.search(pattern, haystack) is not None

    def negated(pattern: str) -> bool:
        return re.search(
            rf"\b(no|not|without|absent|none|no visible|not visible)\b[^.:\n]{{0,80}}{pattern}",
            haystack,
        ) is not None

    tags = []
    if present(r"\bswastikas?\b") and not negated(r"\bswastikas?\b"):
        tags.extend(["swastika", "national_socialism"])
    if present(r"\bsonnenrads?\b") and not negated(r"\bsonnenrads?\b"):
        tags.extend(["sonnenrad", "national_socialism"])
    if present(r"\bblack[_\s-]?suns?\b") and not negated(r"\bblack[_\s-]?suns?\b"):
        tags.extend(["black_sun", "national_socialism"])
    if present(r"\bhammer[_\s-]?and[_\s-]?sickles?\b") and not negated(r"\bhammer[_\s-]?and[_\s-]?sickles?\b"):
        tags.extend(["hammer_and_sickle", "communism"])
    if (
        present(r"\bcommunist\s+red\s+stars?\b")
        or (present(r"\bred\s+stars?\b") and present(r"\bcommunis[mt]\b"))
    ) and not negated(r"\b(red\s+stars?|communist\s+red\s+stars?)\b"):
        tags.extend(["communist_red_star", "communism"])
    return _dedupe_tags(tags)


def _semantic_pose_action_tags_from_text(text: str) -> list[str]:
    haystack = str(text or "").lower()
    candidates = {
        "lying": [
            r"\blying\b",
            r"\blying\s+(?:down|on|in)\b",
            r"\blaying\s+(?:down|on|in)\b",
            r"\breclining\b",
        ],
        "sitting": [r"\bsitting\b", r"\bseated\b"],
        "standing": [r"\bstanding\b"],
        "kneeling": [r"\bkneeling\b"],
        "crouching": [r"\bcrouching\b"],
        "squatting": [r"\bsquatting\b"],
        "walking": [r"\bwalking\b"],
        "running": [r"\brunning\b"],
        "jumping": [r"\bjumping\b"],
        "dancing": [r"\bdancing\b"],
        "sleeping": [r"\bsleeping\b", r"\basleep\b"],
        "stretching": [r"\bstretching\b"],
        "arms_up": [r"\barms?\s+(?:raised|up|overhead)\b", r"\braised\s+arms?\b"],
        "looking_at_viewer": [r"\blooking\s+at\s+(?:the\s+)?viewer\b"],
        "selfie": [r"\bselfie\b"],
    }
    tags = []
    for tag, patterns in candidates.items():
        if any(re.search(pattern, haystack) for pattern in patterns):
            tags.append(tag)
    return _dedupe_tags(tags)


def _semantic_tags_from_text(text: str) -> list[str]:
    haystack = str(text or "").lower()
    negated_political = any(
        phrase in haystack
        for phrase in (
            "no visible political",
            "no political",
            "no protest",
            "no propaganda",
            "no extremist",
            "without political",
            "without protest",
            "without propaganda",
        )
    )
    negative_context = any(
        phrase in haystack
        for phrase in (
            "no stronger context",
            "no indications of being",
            "no visible",
            "without any indications",
        )
    )
    candidates = {
        "person": ["person", "people", "man", "woman"],
        "woman": ["woman", "female"],
        "man": ["man", "male"],
        "photo": ["photo", "photograph", "realistic", "natural lighting"],
        "realistic": ["realistic", "photograph", "natural lighting"],
        "natural_lighting": ["natural lighting"],
        "indoors": ["indoors", "inside", "room"],
        "outdoors": ["outdoors", "outside", "street"],
        "bikini": ["bikini", "swimsuit"],
        "swimwear": ["bikini", "swimsuit", "swimwear"],
        "pink": ["pink"],
        "pink_clothing": ["pink bikini", "pink dress", "pink shirt", "pink clothing"],
        "patterned_clothing": ["patterned", "print", "strawberry patterns", "strawberry print"],
        "strawberry_print": ["strawberry patterns", "strawberry print"],
        "meme": ["meme"],
        "screenshot": ["screenshot"],
        "captioned": ["caption", "captioned", "subtitle", "text overlay"],
        "political_edit": ["political edit"],
        "meme_edit": ["meme edit"],
        "amv": ["amv"],
        "music_video": ["music video"],
        "propaganda": ["propaganda"],
        "protest": ["protest"],
    }
    tags = []
    for tag, needles in candidates.items():
        if negated_political and tag in {"political_edit", "propaganda", "protest"}:
            continue
        if negative_context and tag in {"meme_edit", "amv", "music_video"}:
            continue
        if any(_semantic_phrase_present(haystack, needle) for needle in needles):
            tags.append(tag)
    return tags[:10]


def _semantic_phrase_present(haystack: str, phrase: str) -> bool:
    words = [re.escape(part) for part in re.findall(r"[a-z0-9]+", str(phrase or "").lower())]
    if not words:
        return False
    separator = r"[\s_-]+"
    pattern = separator.join(words)
    return re.search(rf"(?<![a-z0-9]){pattern}(?![a-z0-9])", haystack) is not None


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


def _sample_video_frames(path: Path, opts: AutoTagOptions, *, frame_count: int, prefix: str) -> list[tuple[float, Path]]:
    if not check_ffmpeg_available():
        return []
    duration = _probe_duration(path)
    if duration and duration > opts.videoMaxDurationSeconds:
        duration = float(opts.videoMaxDurationSeconds)
    sample_opts = replace(opts, videoMaxFrames=max(1, min(8, int(frame_count or 1))))
    timestamps = _timestamps(duration, sample_opts)
    return _extract_video_frames_at_timestamps(path, timestamps, prefix=prefix)


def _sample_qwen_video_frames(path: Path, opts: AutoTagOptions) -> tuple[list[tuple[float, Path]], str]:
    if not opts.qwenVideoUseFps:
        return _sample_video_frames(path, opts, frame_count=1, prefix="qwen-video-single-"), "single"
    if not check_ffmpeg_available():
        return [], "contact_sheet_2fps"
    duration = _probe_duration(path)
    if duration and duration > opts.videoMaxDurationSeconds:
        duration = float(opts.videoMaxDurationSeconds)
    timestamps = _fps_timestamps(duration, fps=2.0, max_frames=opts.qwenVideoMaxFrames)
    return _extract_video_frames_at_timestamps(path, timestamps, prefix="qwen-video-2fps-"), "contact_sheet_2fps"


def _fps_timestamps(duration: float | None, *, fps: float, max_frames: int) -> list[float]:
    if not duration or duration <= 0 or fps <= 0:
        return []
    limit = max(1, min(64, int(max_frames or 1)))
    step = 1.0 / fps
    start = min(max(duration / 2.0, 0.0), step / 2.0)
    timestamps: list[float] = []
    current = start
    while current < duration and len(timestamps) < limit:
        timestamps.append(max(0.0, min(duration - 0.05, current)))
        current += step
    return sorted({round(ts, 3) for ts in timestamps})


def _extract_video_frames_at_timestamps(path: Path, timestamps: list[float], *, prefix: str) -> list[tuple[float, Path]]:
    if not timestamps:
        return []
    cache_root = settings.cache_dir / "auto-tags"
    cache_root.mkdir(parents=True, exist_ok=True)
    tmpdir = Path(tempfile.mkdtemp(prefix=prefix, dir=cache_root))
    frames: list[tuple[float, Path]] = []
    try:
        for idx, ts in enumerate(timestamps):
            frame = tmpdir / f"frame-{idx}.jpg"
            if _extract_frame(path, frame, ts) and not _is_near_black(frame):
                frames.append((ts, frame))
        if frames:
            return frames
    except Exception:
        pass
    shutil.rmtree(tmpdir, ignore_errors=True)
    return []


def _tag_video_frames_with_image_enrichers(
    frames: list[tuple[float, Path]],
    opts: AutoTagOptions,
    context: dict | None = None,
) -> AutoTagResult:
    frame_results: list[tuple[float, AutoTagResult]] = []
    for ts, frame in frames:
        result = _combine_results(_optional_image_results(frame, opts, context=context, include_qwen=False))
        if result.all_tags or result.rating or result.error:
            frame_results.append((ts, result))
    if not frame_results:
        return AutoTagResult(enabled=True, model="frame-enrichers", error="no_video_frames")
    merged = _merge_frame_results(frame_results, opts)
    merged.model = "+".join(_dedupe_plain_strings([result.model for _, result in frame_results if result.model])) or "frame-enrichers"
    if isinstance(merged.evidence, dict):
        merged.evidence["kind"] = "video_frame_enrichers"
    return merged


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
    unavailable = _unavailable_model_result("wd")
    if unavailable:
        return unavailable
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
    frame_count = max(1, min(8, int(opts.videoMaxFrames or 1)))
    if opts.videoFrameStrategy == "middle" or frame_count == 1:
        points = [0.5]
    elif frame_count == 2:
        points = [1 / 3, 2 / 3]
    elif frame_count == 3:
        points = [0.25, 0.5, 0.75]
    elif frame_count == 4:
        points = [0.20, 0.40, 0.60, 0.80]
    else:
        step = 1.0 / (frame_count + 1)
        points = [step * (idx + 1) for idx in range(frame_count)]
    return [max(0.0, min(duration - 0.05, duration * p)) for p in points[:frame_count]]


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
        "durationMs": result.duration_ms,
    })


def _letterbox(image, target: int):
    width, height = image.size
    scale = min(target / width, target / height)
    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    resized = image.resize(new_size, Image.BICUBIC)
    canvas = Image.new("RGB", (target, target), (255, 255, 255))
    canvas.paste(resized, ((target - new_size[0]) // 2, (target - new_size[1]) // 2))
    return canvas
