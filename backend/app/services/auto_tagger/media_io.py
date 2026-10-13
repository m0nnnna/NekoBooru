"""Image, video and audio preprocessing shared by the taggers (tensors, frames, vocabularies)."""
from __future__ import annotations

import csv
import base64
import json
import math
import shutil
import subprocess
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from ...config import settings
from ..media import check_ffmpeg_available
from .. import auto_tagger as _at
from .core import (
    AutoTagOptions,
    AutoTagResult,
    CL_QUALITY_WORDS,
    CL_RATING_WORDS,
    normalize_tag,
    qualified_display_name,
    QWEN_ANALYSIS_MAX_SIDE,
    WHISPER_MAX_AUDIO_SECONDS,
)


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


class _TagVocabulary:
    """A tagger's vocabulary, prepared once at load time.

    ``tags`` and ``qualified`` hold normalize_tag() / qualified_display_name()
    per index, and ``passing()`` thresholds a whole score vector in numpy. The
    taggers used to run both regexes for every one of 10k-108k tags on every
    image before looking at the score; now that work happens once, and only
    the few tags that clear their threshold reach Python at all.
    """

    def __init__(self, names: list[str | None], categories: list[str | None]) -> None:
        import numpy as np  # type: ignore

        self.tags = [normalize_tag(name) if name else "" for name in names]
        self.qualified = [qualified_display_name(name) if name else None for name in names]
        self.category_names = sorted({category for category in categories if category is not None})
        code_for = {category: code for code, category in enumerate(self.category_names)}
        # -1 marks an index with no tag or no category; it never passes.
        self.codes = np.asarray(
            [code_for[category] if name and category is not None else -1 for name, category in zip(names, categories)],
            dtype=np.int32,
        )

    def passing(self, scores, limit_for) -> list[int]:
        """Indexes whose score reaches ``limit_for(category)``; a None limit never passes."""
        import numpy as np  # type: ignore

        scores = np.asarray(scores, dtype=np.float64).reshape(-1)
        count = min(len(scores), len(self.codes))
        lookup = np.full(len(self.category_names) + 1, np.inf, dtype=np.float64)
        for code, category in enumerate(self.category_names):
            limit = limit_for(category)
            if limit is not None:
                lookup[code] = float(limit)
        # Code -1 indexes the trailing inf.
        limits = lookup[self.codes[:count]]
        return np.nonzero(scores[:count] >= limits)[0].tolist()


# Every tagger input is 512 px or smaller. Decoding the full original for each
# model cost over a second per model on 30-70 megapixel files, so the source
# is decoded once per file, already shrunk, and shared by every model that
# tags the same image. The short side never drops below TAGGER_SOURCE_MIN_SIDE:
# models that squash to a square (CL) would otherwise have to stretch a
# panorama's few remaining rows back up.
TAGGER_SOURCE_MAX_SIDE = 2048
TAGGER_SOURCE_MIN_SIDE = 1024
_source_image_lock = threading.Lock()


def _source_rgb(path: Path):
    """The image at ``path`` as RGB, shrunk toward TAGGER_SOURCE_MAX_SIDE on its long side."""
    try:
        stat = Path(path).stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        key = None
    with _source_image_lock:
        if key is not None and _at._source_image_cache is not None and _at._source_image_cache[0] == key:
            return _at._source_image_cache[1]

    with Image.open(path) as image:
        # JPEG decodes straight to a 1/2, 1/4 or 1/8 scale that still covers
        # the target; other formats ignore this.
        image.draft("RGB", (TAGGER_SOURCE_MIN_SIDE, TAGGER_SOURCE_MIN_SIDE))
        image = image.convert("RGB")
    factor = min(math.ceil(max(image.size) / TAGGER_SOURCE_MAX_SIDE), min(image.size) // TAGGER_SOURCE_MIN_SIDE)
    if factor > 1:
        # Box-filter reduction: fast, and it averages rather than aliases.
        image = image.reduce(factor)

    if key is not None:
        with _source_image_lock:
            _at._source_image_cache = (key, image)
    return image


def _generic_onnx_image_tensor(path: Path, image_size: int, shape):
    import numpy as np  # type: ignore

    image = _letterbox(_source_rgb(path), image_size)
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

    img = _source_rgb(path)
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

    resized = _source_rgb(path).resize((image_size, image_size), Image.BICUBIC)
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
    # A frame the user picked replaces the sampling entirely - they looked at
    # the video, the heuristic did not.
    if opts.videoFrameTime is not None:
        return [max(0.0, min(duration - 0.05, float(opts.videoFrameTime)))]
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


def _letterbox(image, target: int):
    width, height = image.size
    scale = min(target / width, target / height)
    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    resized = image.resize(new_size, Image.BICUBIC)
    canvas = Image.new("RGB", (target, target), (255, 255, 255))
    canvas.paste(resized, ((target - new_size[0]) // 2, (target - new_size[1]) // 2))
    return canvas
