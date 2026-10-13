"""The OCR, Whisper and Qwen (transformers and GGUF) taggers, with their singletons."""
from __future__ import annotations

import threading
import uuid
from pathlib import Path

from PIL import Image

from ...config import settings
from .cache import _hf_cache_dir, _qwen_gguf_paths
from .core import (
    AutoTagOptions,
    AutoTagResult,
    MODEL_REGISTRY,
    normalize_tag,
    QWEN_GGUF_MAX_TOKENS,
    QWEN_MAX_NEW_TOKENS,
    QWEN_VIDEO_FPS,
)
from .media_io import (
    _analysis_image_evidence,
    _chat_completion_text,
    _extract_audio,
    _image_data_url,
    _video_input_frame_count,
    _whisper_audio_seconds,
)
from .options import huggingface_token, load_options
from .runtime import (
    _clear_torch_cache,
    _normalize_torch_device,
    _prepare_llama_cpp_runtime,
    _qwen_device_map,
    _qwen_gguf_use_gpu,
    _transformers_pipeline,
)
from .semantic import (
    _compact_semantic_raw_output,
    _looks_political,
    _meaningful_ocr_text,
    _parse_semantic_json,
    _sanitize_qwen_semantic_payload,
    _semantic_prompt_with_context,
    _semantic_tag_limit,
    _whisper_tags_from_text,
    normalize_safety_label,
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


_ocr_tagger = OcrTagger()
_whisper_tagger = WhisperTagger()
_qwen_tagger = QwenSemanticTagger()
_qwen_gguf_q4_tagger = QwenGgufSemanticTagger("qwen_gguf_q4")
_qwen_gguf_q8_tagger = QwenGgufSemanticTagger("qwen_gguf_q8")
