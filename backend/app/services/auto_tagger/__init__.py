"""Optional local image/video auto-tagging for NekoBooru.

This package was one module; it is split by functionality but still behaves as
one namespace. Every name the old module had is re-exported here, and:

- Process-wide state that gets rebound (job slots, CUDA/llama.cpp flags, the
  source-image cache) lives in this module, and the parts read and write it as
  ``_at.<name>``. Callers and tests that read or assign
  ``auto_tagger._download_job`` and friends therefore see the live value.
- Every other name is a plain re-export. A part looks up the names it imported
  in its own globals, so to redirect a caller inside a part, patch the name on
  the part that calls it (``app.services.auto_tagger.dispatch.runtime_available``),
  not on the package.

Parts, in import order (each imports only from the ones before it):
  core          Model ids, the model registry, and the option/result dataclasses every auto-tagger part shares.
  runtime       Torch, onnxruntime and llama.cpp runtime discovery, CUDA preparation and GPU fallbacks.
  semantic      Semantic-prompt building, semantic output parsing, and tag merging/normalisation helpers.
  options       Loading, saving and validating AutoTagOptions, plus the stored HuggingFace and worker tokens.
  cache         HuggingFace cache lookup: where each model's files live and whether they are downloaded.
  downloads     The model download job: one job with a dynamic queue, driven by huggingface_hub.
  media_io      Image, video and audio preprocessing shared by the taggers (tensors, frames, vocabularies).
  media_taggers The OCR, Whisper and Qwen (transformers and GGUF) taggers, with their singletons.
  onnx_taggers  The ONNX image taggers: WD, PixAI, Camie and CL, with their singletons.
  models        Model status, the single-worker model load queue, unloading, and cache deletion.
  dispatch      tag_media() and the per-model dispatch, remote-worker forwarding, and result merging.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    import threading

    from PIL import Image


# Rebound process-wide state. The parts access these as ``_at.<name>``.
_ONNX_CUDA_PREPARED = False
_ONNX_CUDA_DISABLED = False
_download_job: dict[str, Any] | None = None
_load_job: dict[str, Any] | None = None
_load_worker: threading.Thread | None = None
# Models already rebuilt on CPU after a CUDA fault, so a tagger that is broken
# for some other reason costs one retry per process rather than one per image.
_ONNX_CPU_REBUILT: set[str] = set()
# Whether transformers' pipeline imported, once something has needed it.
_TRANSFORMERS_PIPELINE_OK: bool | None = None
_LLAMA_CPP_PREPARED = False
_LLAMA_CPP_IMPORTABLE = False
_source_image_cache: tuple[tuple, "Image.Image"] | None = None

from . import (  # noqa: E402  (the parts read the state above at call time)
    core,
    runtime,
    semantic,
    options,
    cache,
    downloads,
    media_io,
    media_taggers,
    onnx_taggers,
    models,
    dispatch,
)

_PARTS = (core, runtime, semantic, options, cache, downloads, media_io, media_taggers, onnx_taggers, models, dispatch)

for _part in _PARTS:
    for _name, _value in vars(_part).items():
        if _name.startswith("__") or _name == "_at":
            continue
        globals().setdefault(_name, _value)
del _part, _name, _value
