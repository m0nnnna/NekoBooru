# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

NekoBooru — a self-hosted, single-user booru-style image/video gallery.

- **Backend**: FastAPI + SQLAlchemy + SQLite, in [backend/](backend/)
- **Frontend**: Vue 3 + Vite + Pinia, in [frontend/](frontend/)
- **Browser extension**: MV3 extension in [browser-extension/](browser-extension/)
- **Optional AI auto-tagging**: local ONNX/torch model stack, off by default and not part of the base install

There is no authentication. The backend binds loopback by default.

---

## Rules

### 1. Never hardcode absolute paths

This is the most important rule in this repo. It applies to Python, JS, Vue, shell/batch/PowerShell scripts, docs, tests, and any file you create.

**Do not write** machine-specific paths like `X:\Documents\OSP\Nekobooru\NekoBooru\...`, `C:\Users\<name>\...`, `/home/<user>/...`, or hardcoded HuggingFace cache paths. They break every other machine, the packaged binary, and CI.

Instead:

- **Backend runtime locations** — always go through [backend/app/runtime_paths.py](backend/app/runtime_paths.py) / `settings` from [backend/app/config.py](backend/app/config.py): `settings.data_dir`, `settings.config_dir`, `settings.config_file`, `settings.models_dir`, `settings.logs_dir`, `settings.cache_dir`, `settings.runtimes_dir`. These already resolve correctly for source checkouts, frozen PyInstaller builds, and portable mode, and each honors a `NEKO_*` env override.
- **Locating files relative to code** — `Path(__file__).resolve().parents[N] / "..."`, never a literal root.
- **Scripts** — use the script's own directory (`%~dp0` in batch, `$PSScriptRoot` in PowerShell, `$(dirname "$0")` in sh) and relative paths from there.
- **Tests** — build temp dirs with `tempfile.TemporaryDirectory()` and point the `NEKO_*` env vars at them (see `setUpClass` in [tests/test_auto_tags.py](tests/test_auto_tags.py) for the established pattern).
- **Docs and comments** — refer to repo-relative paths (`backend/app/services/auto_tagger.py`), never absolute ones.
- **Model files** — resolve through `model_cache_status(model_id)` and the `_cached_file*` helpers, never by constructing a snapshot path by hand.

When you need to run a command against the project venv, use a repo-relative invocation (`venv/Scripts/python.exe` on Windows, `venv/bin/python` elsewhere) rather than pasting an absolute one into a committed file. Absolute paths typed into a terminal for a one-off command are fine; absolute paths *written into a file* are not.

### 2. Multi-agent runs: isolated worktree → fast-forward onto main

Any run with more than one agent working at once **must** isolate each agent, and no task is finished until its commit is on `main`. Never let two agents write to the same checkout.

**Per agent — work in its own worktree and branch:**

```bash
git worktree add ../nekobooru-<task> -b <task>    # from the repo root
# ...the agent works, tests, and commits inside ../nekobooru-<task>...
```

With the Agent tool, `isolation: "worktree"` does this for you. Never skip it when agents run concurrently.

**Integrate — fast-forward only, so main is never a merge mess:**

```bash
git -C ../nekobooru-<task> fetch origin           # or: git fetch, if main is local-only
git -C ../nekobooru-<task> rebase main            # replay onto current main first
git checkout main
git merge --ff-only <task>                        # fails loudly if it would not fast-forward
git worktree remove ../nekobooru-<task>
git branch -d <task>
```

If `--ff-only` is refused, main moved: go back to the worktree, rebase again, re-run the tests there, and retry. Never `--no-ff`, never force, never merge a branch whose tests you have not re-run after the rebase.

**Definition of done:** the change is on `main`, `main` builds, and `main`'s tests pass. A green branch is not done. Report the merged commit SHA. If integration is blocked, say so explicitly and leave the branch intact rather than reporting success.

**Serialize the conflict-prone paths.** `frontend/dist/` is committed and built with content-hashed filenames, so two agents that both touch `frontend/src/` produce guaranteed, unmergeable conflicts. Give frontend work to a single agent, or have agents change only `frontend/src/` and rebuild `dist` once at integration time on `main`. The same applies to any single large file several agents want — most of all [backend/app/services/auto_tagger.py](backend/app/services/auto_tagger.py).

### 3. Rebuild the frontend when you change it

`frontend/dist/` is **committed to the repo** — the packaged app serves it. After any change under `frontend/src/`, run `npm run build` in [frontend/](frontend/) and commit the regenerated `dist/` alongside the source change. See the recurring "Rebuild frontend assets" commits.

### 4. Keep AI dependencies optional

`torch`, `onnxruntime`, `transformers`, `llama-cpp-python` etc. live in `backend/requirements-tagger*.txt`, not `backend/requirements.txt`, and must never be imported at module scope in code that the base app loads. Import them **inside the function that needs them** (`import onnxruntime as ort` inside `_load()`), and gate availability through `runtime_available(model_id)` / `find_spec`. The base install and the shipped binary must keep working with none of them present.

### 5. Match the surrounding style

Python: `from __future__ import annotations`, dataclasses, `pathlib`, type hints, no docstring ceremony on small helpers. Vue: Composition API with `<script setup>`, Pinia stores. Avoid adding new dependencies.

---

## Commands

All commands are relative to the repo root.

```bash
# Dev (both servers)
start-dev.bat          # Windows
./start-dev.sh         # Linux/macOS

# Backend only
cd backend && python run.py            # dev, port 8772
# Frontend only
cd frontend && npm run dev             # port 5173, proxies /api to 8772

# Backend tests (unittest; must be run from the tests/ dir)
cd tests && ../venv/Scripts/python.exe -m unittest discover -s . -p "test_*.py"    # Windows
cd tests && ../venv/bin/python -m unittest discover -s . -p "test_*.py"            # Linux/macOS

# Frontend tests (vitest)
cd frontend && npm run test

# Frontend production build (REQUIRED after src changes — dist/ is committed)
cd frontend && npm run build
```

Known baseline: `test_extension_upload_defaults_can_be_saved` in [tests/test_auto_tags.py](tests/test_auto_tags.py) fails on a clean tree. Don't attribute it to your change; everything else should pass.

Env vars: `NEKO_PORT`, `NEKO_HOST`, `NEKO_DEBUG`, `NEKO_CORS_ORIGINS`, plus the path overrides `NEKO_APP_DIR`, `NEKO_CONFIG_DIR`, `NEKO_CONFIG_FILE`, `NEKO_DATA_DIR`, `NEKO_LOGS_DIR`, `NEKO_MODELS_DIR`, `NEKO_RUNTIMES_DIR`, `NEKO_CACHE_DIR`, and `NEKO_TAGGER_WORKER_TOKEN`.

---

## Layout

```
backend/app/
  main.py            FastAPI app
  config.py          settings (wraps runtime_paths)
  runtime_paths.py   package-aware path resolution — the only place paths are decided
  routers/           API endpoints (auto_tags, posts, tags, uploads, settings, ...)
  models/            SQLAlchemy models
  services/          business logic (auto_tagger, auto_tag_jobs, media, search, tagging, ...)
frontend/src/
  views/             HomeView, PostView, UploadView, SettingsView, ...
  components/        reusable components
  stores/            Pinia
  api/client.js      API client
frontend/dist/       COMMITTED build output
browser-extension/   MV3 extension (has its own copy of AI model default logic)
tests/               backend unittest suite
data/ config/ logs/ models/   gitignored runtime dirs
```

---

## The auto-tagging system

Everything lives in [backend/app/services/auto_tagger.py](backend/app/services/auto_tagger.py) (~4k lines) and is exposed by [backend/app/routers/auto_tags.py](backend/app/routers/auto_tags.py) under `/api/auto-tags`.

**Core pieces:**

- `MODEL_REGISTRY` — dict of `model_id -> metadata` (repo id, display name, download size, VRAM, required files/patterns). Drives downloads, cache status, and the Settings UI.
- Tagger classes — `WdTagger`, `PixAiTagger`, `CamieTagger`, `OcrTagger`, `WhisperTagger`, `QwenSemanticTagger`, `QwenGgufSemanticTagger`. Each is a lazily-loading singleton (`_wd_tagger`, `_camie_tagger`, ...) with `is_loaded()` / `ensure_loaded()` / `unload()` / `_load()` and a `tag_image()` (or `read_image()` / `analyze_*()`) that returns an `AutoTagResult`.
- `AutoTagOptions` — dataclass of every user-facing setting; persisted through `SettingsManager` and normalized by `validate_options()`. One `<model>Enabled` boolean per model (note: Camie's flag is the historically-named `characterModelEnabled`).
- `AutoTagResult` — tags / character_tags / copyright_tags / rating / safety / categories / evidence / model / error / duration_ms. Multiple models' results are merged by `_combine_results()`.
- Dispatch — `tag_media()` → `_tag_image()` / `_tag_video_with_enrichers()` → `_optional_image_results()`, which checks each `opts.<model>Enabled` flag and calls `_unavailable_model_result(model_id) or _run_optional(model_id, ...)`.
- `_tagger_for_model(model_id)` maps ids to singletons; `runtime_available(model_id)` declares which Python packages that model needs; `_model_runtime_providers(model_id)` reports the ONNX/llama.cpp providers in use.
- Downloads go through the HuggingFace hub with progress jobs (`start_model_download`, `_run_model_download_job`, `model_cache_status`, `delete_model_cache`).
- **Remote worker**: when `opts.remoteEnabled`, `tag_media()` forwards the file to another instance's `/api/auto-tags/infer` instead of running locally.

`onnxruntime-gpu` bundles no CUDA libraries. `_prepare_onnx_cuda_runtime()` preloads cuDNN 9 and the CUDA 12 runtime out of the installed torch (or `nvidia-*`) wheels before the first session is built — without it every ONNX tagger silently falls back to CPU on Windows. Adding the directory to the DLL search path is not sufficient; the libraries must actually be resident.

### Concurrency

Three separate mechanisms, easy to conflate:

- `_gpu_work_lock` serializes everything that touches the GPU — `tag_media()`'s local inference, model loads, and unloads. Held **per media item**, not per job, so a queued load still gets a turn between images. Remote-worker tagging deliberately skips it (that GPU is on another machine). Lock order is always `_gpu_work_lock` → the tagger's own `_lock`; do not invert it.
- **Downloads** are one job with a dynamic queue. `start_model_download()` appends to the running job instead of failing, and the worker re-reads the pending list each pass. The job is finalized under `_download_lock` in the same critical section that finds the queue empty — otherwise a model enqueued at that instant would be stranded in a finished job.
- **Model loads** are a `_load_queue` drained by a single worker thread. `start_model_load()` for a second model queues it; it must never return the in-flight job for a different model, which is what used to leave the UI polling a load that would never happen.

Bulk auto-tag jobs (`auto_tag_jobs.create_job`) are still one-at-a-time and reject with a 409 while one runs — they are DB-backed and not part of the queue above.

**ONNX helper toolkit** (reuse these rather than writing new preprocessing): `_create_onnx_session`, `_onnx_input_image_size`, `_generic_onnx_image_tensor`, `_imagenet_tensor`, `_flatten_onnx_scores`, `_cached_file`, `_cached_file_by_suffix`, `_cached_tag_metadata_file`, `_read_tag_rows_from_csv`, `_read_tag_rows_from_json`, `normalize_tag`, `safety_from_rating`.

### Adding a new tagger model

A model id touches more places than you'd expect. Use `cl` or `pixai` (the two most recently added ONNX taggers) as the reference implementation and grep for one of them — every hit is a place you likely need a matching entry.

Backend ([backend/app/services/auto_tagger.py](backend/app/services/auto_tagger.py)):
1. `MODEL_REGISTRY` entry (id, name, repoId, purpose, downloadSize, vramRequirement, `allowPatterns` / `requiredFiles` / `requiredFileKinds`, plus `expectedTotalBytes` and `downloadAll: False` for large or gated repos).
2. A tagger class + module-level singleton.
3. `AutoTagOptions.<model>Enabled` field (defaults to `False`).
4. `_tagger_for_model()` branch.
5. `runtime_available()` branch, `_model_runtime_providers()` branch, and the `<model>Providers` key in `_onnx_runtime_info()` for ONNX models.
6. `_optional_image_results()` — run it when the flag is set; add to the `visual_enrichers` condition in `_tag_video_with_enrichers()` if it should also see sampled video frames.
7. `_new_load_job()` load-time estimate.

Backend router ([backend/app/routers/settings.py](backend/app/routers/settings.py)):
8. Add the new flag to the key tuple in `_normalize_ai_model_default_stack()`.

Frontend (all four views keep their own copy of the model-key lists — keep them in sync):
9. [SettingsView.vue](frontend/src/views/SettingsView.vue) — `aiDefaultModels`, the model-key array near the top of the AI section, `modelSettingKey()`, `modelPipelineLabel()`, `modelPipelineDescription()`, and the profile-default builders.
10. [HomeView.vue](frontend/src/views/HomeView.vue) — `aiModelDefaultKeys`, the model toggle list, and the `anime` / `realistic` profile defaults.
11. [PostView.vue](frontend/src/views/PostView.vue) — the model list, `modelSettingKey` map, profile defaults, and the runtime-requirement helper.
12. [UploadView.vue](frontend/src/views/UploadView.vue) — the model-key loop and profile defaults.
13. [browser-extension/upload.js](browser-extension/upload.js) — profile defaults, the model-key array, the id→flag map, and the runtime-requirement helper.
14. Rebuild `frontend/dist`.

Tests ([tests/test_auto_tags.py](tests/test_auto_tags.py)):
15. Add the id to the model-listing / download-all assertions and add a tagging test mirroring the existing `pixai` / `camie` cases.

Docs: mention the model in [README.md](README.md)'s auto-tagging section.

---

## Gotchas

- Long-running greps over the repo root are slow because `venv/`, `node_modules/`, `build-venv/`, and `models/` are large — prefer the Grep tool (ripgrep, respects gitignore) over shelling out to `grep -r`.
- `data/`, `config/`, `logs/`, `models/` are gitignored runtime state — never commit them, and never assume their contents exist.
- The tests import `app.*` by inserting `backend/` on `sys.path`, so they must be run from `tests/`.
- Windows is the primary dev platform here, but everything must keep working on Linux/macOS and inside the PyInstaller build ([nekobooru.spec](nekobooru.spec)).
