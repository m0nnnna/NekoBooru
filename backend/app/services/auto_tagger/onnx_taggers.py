"""The ONNX image taggers: WD, PixAI, Camie and CL, with their singletons."""
from __future__ import annotations

import csv
import json
import threading
import gc
from pathlib import Path

from .cache import _hf_cache_dir, model_cache_status
from .core import (
    AutoTagOptions,
    AutoTagResult,
    CL_IMAGE_SIZE,
    CL_MIN_THRESHOLD,
    CL_MODEL_VERSION,
    MODEL_REGISTRY,
    safety_from_rating,
    WD_MODEL_ID,
)
from .media_io import (
    _cached_file,
    _cached_file_by_suffix,
    _cached_tag_metadata_file,
    _flatten_onnx_scores,
    _generic_onnx_image_tensor,
    _imagenet_tensor,
    _letterbox,
    _onnx_input_image_size,
    _read_cl_vocabulary,
    _read_pixai_tag_rows,
    _siglip_tensor,
    _source_rgb,
    _TagVocabulary,
)
from .options import huggingface_token
from .runtime import _create_onnx_session
from .semantic import _camie_safety


class WdTagger:
    name = "wd-eva02-large-tagger-v3"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._session = None
        self._tag_rows: list[tuple[str, int]] = []
        self._vocab: _TagVocabulary | None = None
        self._providers: list[str] = []

    def is_loaded(self) -> bool:
        return self._loaded

    def unload(self) -> bool:
        with self._lock:
            was_loaded = self._loaded
            self._session = None
            self._tag_rows = []
            self._vocab = None
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
        # The cache first: without local_files_only every load asked
        # huggingface.co for both files' etags, the bulk of WD's load time.
        # The network is only used when a file is genuinely missing.
        try:
            model_path = hf_hub_download(
                WD_MODEL_ID, "model.onnx", token=token, cache_dir=_hf_cache_dir(), local_files_only=True
            )
            tags_path = hf_hub_download(
                WD_MODEL_ID, "selected_tags.csv", token=token, cache_dir=_hf_cache_dir(), local_files_only=True
            )
        except Exception:  # noqa: BLE001 - not cached yet: download as before
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
        self._vocab = None
        self._vocabulary()

    def _vocabulary(self) -> "_TagVocabulary":
        if self._vocab is None:
            self._vocab = _TagVocabulary(
                [name for name, _ in self._tag_rows], [str(category) for _, category in self._tag_rows]
            )
        return self._vocab

    def tag_image(self, path: Path, opts: AutoTagOptions) -> AutoTagResult:
        self.ensure_loaded()
        import numpy as np  # type: ignore

        image = _letterbox(_source_rgb(path), 448)
        arr = np.asarray(image, dtype=np.float32)[None, ...]

        input_name = self._session.get_inputs()[0].name
        scores = self._session.run(None, {input_name: arr})[0][0]

        general: list[tuple[str, float]] = []
        characters: list[tuple[str, float]] = []
        rating: dict[str, float] = {}
        display_names: dict[str, str] = {}

        # Category 0 is general, 4 character, 9 rating (every rating is kept).
        limits = {"0": opts.generalThreshold, "4": opts.characterThreshold, "9": float("-inf")}
        for idx in self._vocabulary().passing(scores, limits.get):
            name, category = self._tag_rows[idx]
            confidence = float(scores[idx])
            norm = self._vocabulary().tags[idx]
            qualified = self._vocabulary().qualified[idx]
            if qualified:
                display_names[norm] = qualified
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
            display_names={tag: raw for tag, raw in display_names.items() if tag in categories},
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
        self._vocab: _TagVocabulary | None = None
        self._image_size = 448
        self._providers: list[str] = []

    def is_loaded(self) -> bool:
        return self._loaded

    def unload(self) -> bool:
        with self._lock:
            was_loaded = self._loaded
            self._session = None
            self._tag_rows = []
            self._vocab = None
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
        self._vocab = None
        self._vocabulary()

    def _vocabulary(self) -> "_TagVocabulary":
        if self._vocab is None:
            self._vocab = _TagVocabulary([name for name, _ in self._tag_rows], [category for _, category in self._tag_rows])
        return self._vocab

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
        display_names: dict[str, str] = {}
        character_limit = max(float(opts.characterThreshold), float(MODEL_REGISTRY["pixai"].get("characterThreshold") or 0.85))

        def limit_for(category: str) -> float:
            if category == "rating":
                return 0.01
            if category == "character":
                return character_limit
            if category in {"copyright", "artist"}:
                return opts.characterThreshold
            return opts.generalThreshold

        for idx in self._vocabulary().passing(scores, limit_for):
            name, category = self._tag_rows[idx]
            confidence = float(scores[idx])
            tag = self._vocabulary().tags[idx]
            if not tag:
                continue
            qualified = self._vocabulary().qualified[idx]
            if qualified:
                display_names[tag] = qualified
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
            display_names={tag: raw for tag, raw in display_names.items() if tag in categories},
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
        self._vocab: _TagVocabulary | None = None
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
            self._vocab = None
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
        self._vocab = None
        self._vocabulary()
        self._session = _create_onnx_session(ort, model_path)
        self._providers = list(self._session.get_providers())

    def _vocabulary(self) -> "_TagVocabulary":
        if self._vocab is None:
            size = max((int(key) for key in self._idx_to_tag if key.isdigit()), default=-1) + 1
            names = [self._idx_to_tag.get(str(idx)) for idx in range(size)]
            self._vocab = _TagVocabulary(
                names,
                [self._tag_to_category.get(name, "general") if name else None for name in names],
            )
        return self._vocab

    def tag_image(self, path: Path, opts: AutoTagOptions) -> AutoTagResult:
        self.ensure_loaded()
        import numpy as np  # type: ignore

        arr = _imagenet_tensor(path, self._image_size)
        input_name = self._session.get_inputs()[0].name
        outputs = self._session.run(None, {input_name: arr})
        logits = outputs[1] if len(outputs) >= 2 else outputs[0]
        probs = 1.0 / (1.0 + np.exp(-logits[0]))

        display_names: dict[str, str] = {}
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
        for idx in self._vocabulary().passing(probs, lambda category: threshold_by_category.get(category, opts.generalThreshold)):
            tag = self._idx_to_tag.get(str(idx))
            if not tag:
                continue
            category = self._tag_to_category.get(tag, "general")
            confidence = float(probs[idx])
            if confidence >= threshold_by_category.get(category, opts.generalThreshold):
                normalized = self._vocabulary().tags[idx]
                qualified = self._vocabulary().qualified[idx]
                if qualified:
                    display_names[normalized] = qualified
                by_category.setdefault(category, []).append((normalized, confidence))

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
            display_names={tag: raw for tag, raw in display_names.items() if tag in categories},
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
        self._vocab: _TagVocabulary | None = None
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
            self._vocab = None
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
        self._vocab = None
        self._vocabulary()

    def _vocabulary(self) -> "_TagVocabulary":
        if self._vocab is None:
            names = [self._idx_to_tag.get(idx) for idx in range(max(self._idx_to_tag, default=-1) + 1)]
            self._vocab = _TagVocabulary(names, [self._tag_to_category.get(name) if name else None for name in names])
        return self._vocab

    def tag_image(self, path: Path, opts: AutoTagOptions) -> AutoTagResult:
        self.ensure_loaded()
        import numpy as np  # type: ignore

        arr = _siglip_tensor(path, self._image_size)
        outputs = self._session.run(None, {self._input_name: arr})
        logits = _flatten_onnx_scores(outputs, np).astype(np.float64)
        probs = 1.0 / (1.0 + np.exp(-logits))

        general_threshold = max(float(opts.generalThreshold), CL_MIN_THRESHOLD)
        character_threshold = max(float(opts.characterThreshold), CL_MIN_THRESHOLD)
        display_names: dict[str, str] = {}
        by_category: dict[str, list[tuple[str, float]]] = {
            "general": [],
            "character": [],
            "copyright": [],
            "meta": [],
            "rating": [],
        }
        def limit_for(category: str) -> float:
            if category == "quality":
                return float("inf")
            if category == "rating":
                return 0.01
            return character_threshold if category in {"character", "copyright"} else general_threshold

        # 108k tags: the numpy pass leaves the per-tag Python work below to the
        # few dozen that can pass, where it used to cost ~0.4 s per image.
        for idx in self._vocabulary().passing(probs, limit_for):
            score = probs[idx]
            raw_tag = self._idx_to_tag.get(idx)
            if not raw_tag:
                continue
            category = self._tag_to_category.get(raw_tag)
            if category is None or category == "quality":
                continue
            tag = self._vocabulary().tags[idx]
            if not tag:
                continue
            qualified = self._vocabulary().qualified[idx]
            if qualified:
                display_names[tag] = qualified
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
        kept = set(categories)

        return AutoTagResult(
            tags=tags,
            character_tags=character_tags,
            copyright_tags=copyright_tags,
            rating=rating,
            safety=_camie_safety(rating, opts) if rating else None,
            categories=categories,
            display_names={tag: raw for tag, raw in display_names.items() if tag in kept},
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


_camie_tagger = CamieTagger()
_cl_tagger = ClTagger()
_pixai_tagger = PixAiTagger()


_wd_tagger = WdTagger()
