"""tag_media() and the per-model dispatch, remote-worker forwarding, and result merging."""
from __future__ import annotations

import json
import logging
import shutil
import tempfile
import time
from dataclasses import asdict
from pathlib import Path

from ...config import settings
from ..media import check_ffmpeg_available
from .. import auto_tagger as _at
from .cache import model_cache_status
from .core import (
    _gpu_work_lock,
    AutoTagOptions,
    AutoTagResult,
    MODEL_REGISTRY,
    normalize_tag,
    qualified_display_name,
    safety_from_rating,
    SUPPORTED_IMAGE_EXTS,
    SUPPORTED_VIDEO_EXTS,
)
from .media_io import (
    _analyze_qwen_image,
    _analyze_qwen_video_frames,
    _extract_frame,
    _is_near_black,
    _probe_duration,
    _sample_qwen_video_frames,
    _sample_video_frames,
    _timestamps,
)
from .media_taggers import _ocr_tagger, _whisper_tagger
from .models import _tagger_for_model, runtime_available
from .onnx_taggers import _camie_tagger, _cl_tagger, _pixai_tagger, _wd_tagger
from .options import _semantic_model_id, load_options, tagger_worker_token
from .runtime import _disable_onnx_cuda, _is_cuda_context_fatal, _ONNX_TAGGER_MODEL_IDS
from .semantic import (
    _add_visual_tag_hints,
    _append_media_type_tag,
    _apply_tag_filters,
    _dedupe_plain_strings,
    _dedupe_tags,
    _higher_safety,
)

logger = logging.getLogger(__package__)


def tag_media(path: Path, opts: AutoTagOptions | None = None) -> AutoTagResult:
    opts = opts or load_options()
    path = Path(path)
    if not opts.enabled:
        return AutoTagResult(enabled=False, error="disabled")
    if opts.remoteEnabled and opts.remoteUrl:
        # Remote work happens on the worker's GPU, so it must not queue behind
        # the local lock.
        return _tag_media_remote(path, opts)
    return _infer_local(path, opts)


def _infer_local(path: Path, opts: AutoTagOptions) -> AutoTagResult:
    """Run the model pipeline in this process (the worker side / local mode).

    Holds the GPU lock here rather than in tag_media() so the worker's /infer
    endpoint is covered too — several callers hitting a worker at once would
    otherwise run concurrent inference and exhaust VRAM.
    """
    path = Path(path)
    with _gpu_work_lock:
        result = _infer_local_locked(path, opts)
    # Outside the lock on purpose: this is network I/O, and holding the GPU
    # while waiting on a booru would stall every other tagging request.
    if opts.booruLookupEnabled:
        _add_booru_copyrights(result, opts)
    return result


def _add_booru_copyrights(result: AutoTagResult, opts: AutoTagOptions) -> None:
    """Add series tags for recognised characters. Purely additive.

    Never removes or reorders what the model produced, and never raises: a slow
    or unreachable booru degrades to the model's own output.
    """
    if not result.character_tags:
        return
    try:
        from ..booru_lookup import copyrights_for_characters

        found = copyrights_for_characters(
            result.character_tags,
            display_names=result.display_names,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("booru copyright lookup failed: %s", exc)
        return

    existing = {normalize_tag(tag) for tag in result.copyright_tags}
    added: list[str] = []
    for character, copyright_name in found.items():
        tag = normalize_tag(copyright_name)
        if not tag or tag in existing:
            continue
        existing.add(tag)
        added.append(tag)
        result.copyright_tags.append(tag)
        result.categories[tag] = "copyright"
        qualified = qualified_display_name(copyright_name)
        if qualified:
            result.display_names.setdefault(tag, qualified)
        logger.info("booru lookup added copyright %s for character %s", tag, character)
    if added and isinstance(result.evidence, dict):
        result.evidence["booruCopyrights"] = added


def _infer_local_locked(path: Path, opts: AutoTagOptions) -> AutoTagResult:
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
        if _is_cuda_context_fatal(exc):
            _disable_onnx_cuda(f"{model_id}: {exc}")
            recovered = _retry_optional_on_cpu(model_id, fn, started)
            if recovered is not None:
                return recovered
        logger.warning("%s pipeline failed: %s", model_id, exc)
        return AutoTagResult(
            enabled=True,
            model=str(MODEL_REGISTRY[model_id]["name"]),
            error=str(exc),
            evidence={"kind": model_id, "error": str(exc)},
            duration_ms=_elapsed_ms(started),
        )


def _retry_optional_on_cpu(model_id: str, fn, started: float) -> AutoTagResult | None:
    """Rebuild an ONNX tagger on CPU after a fatal CUDA fault and run it once more."""
    if model_id not in _ONNX_TAGGER_MODEL_IDS or model_id in _at._ONNX_CPU_REBUILT:
        return None
    _at._ONNX_CPU_REBUILT.add(model_id)
    try:
        _tagger_for_model(model_id).unload()
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not unload %s before the CPU retry: %s", model_id, exc)
        return None
    try:
        result = _set_result_duration(fn(), started)
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s pipeline failed after falling back to CPU: %s", model_id, exc)
        return None
    logger.info("%s recovered on CPU after the CUDA context faulted", model_id)
    return result


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
        combined.display_names.update(result.display_names)
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
