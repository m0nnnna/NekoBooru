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
- **Tests** — build temp dirs with `tempfile.TemporaryDirectory()` and point the `NEKO_*` env vars at them (see `AutoTagApiTestCase.setUpClass` in [tests/auto_tag_support.py](tests/auto_tag_support.py) for the established pattern).
- **Docs and comments** — refer to repo-relative paths (`backend/app/services/auto_tagger/dispatch.py`), never absolute ones.
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

**Running a wave of lanes efficiently** (few fat lanes, claim-then-dispatch, brief and report shapes, one batched landing): [docs/SUBAGENT_RUNBOOK.md](docs/SUBAGENT_RUNBOOK.md). Read it before orchestrating more than two subagents.

**Serialize the conflict-prone paths.** `frontend/dist/` is committed and built with content-hashed filenames, so two agents that both touch `frontend/src/` produce guaranteed, unmergeable conflicts. Give frontend work to a single agent, or have agents change only `frontend/src/` and rebuild `dist` once at integration time on `main`. The same applies to any single large file several agents want — most of all the [backend/app/services/auto_tagger/](backend/app/services/auto_tagger/) package.

### 3. Rebuild the frontend when you change it

`frontend/dist/` is **committed to the repo** — the packaged app serves it. After any change under `frontend/src/`, run `npm run build` in [frontend/](frontend/) and commit the regenerated `dist/` alongside the source change. See the recurring "Rebuild frontend assets" commits.

### 4. Keep AI dependencies optional

`torch`, `onnxruntime`, `transformers`, `llama-cpp-python` etc. live in `backend/requirements-tagger*.txt`, not `backend/requirements.txt`, and must never be imported at module scope in code that the base app loads. Import them **inside the function that needs them** (`import onnxruntime as ort` inside `_load()`), and gate availability through `runtime_available(model_id)` / `find_spec`. The base install and the shipped binary must keep working with none of them present.

### 5. Match the surrounding style

Python: `from __future__ import annotations`, dataclasses, `pathlib`, type hints, no docstring ceremony on small helpers. Vue: Composition API with `<script setup>`, Pinia stores. Avoid adding new dependencies.

### 6. 800 lines per file, split by functionality

No source file may exceed 800 lines. New modules aim for 200-800 lines, grouped by real functionality (a small composable or helper is fine when it is genuinely self-contained; don't shatter code into fragments to hit a number). A change that would push a file past 800 splits it first. The files already over the ceiling are rows in [docs/queues/repo-hygiene.md](docs/queues/repo-hygiene.md); the template for splitting a view is the HomeView split (`25571e4`): components under `frontend/src/components/<area>/`, composables under `frontend/src/composables/`, behaviour-preserving, with a mount test.

### 7. One concern per commit

Every commit carries exactly one change a reviewer could accept or revert on its own: one fix, one feature, one move, one doc update. Two fixes found together are two commits; a build-script tweak noticed while landing is its own commit, not part of the landing's queue edits. A code move (split, rename) never shares a commit with a behaviour change. `frontend/dist/` is always its own "Rebuild frontend assets" commit. Queue edits ride the commit that does the work (the landing commit deletes its row), or go alone when they are pure bookkeeping.

---

## Work tracking: the TODO queues

Follow-up work lives in queues, not in reports or chat. [docs/TODO.md](docs/TODO.md) points to one queue per surface under [docs/queues/](docs/queues/) and to active program plans; it holds no rows itself.

- **Row format**: `- [ ] **what is wrong and the target shape** · area · evidence (file + symbol, commit) · UNCLAIMED`. File it under the surface the work serves.
- **Claim before you start**: append `**TAKEN <date> <who>**` to the row and commit that alone. The landing commit deletes the row.
- **File as you go**: when work turns up a weakness (weak architecture, duplicated logic, missing states or tests, anything short of enterprise grade) or a follow-up outside your scope, fix the immediate defect narrowly and file a row for the rest in the same commit. If you are fixing it in this change, the commit is the record.
- **Subagents in a worktree don't edit the queues** (parallel appends conflict): they put each row verbatim in their report, naming the queue, and the orchestrator files it.

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

Every suite passes on a clean tree: backend, frontend, and each `node browser-extension/*.test.js`. A red test is a real failure.

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
browser-extension/   MV3 extension (fetches the AI model registry; ships a fallback copy)
tests/               backend unittest suite
data/ config/ logs/ models/   gitignored runtime dirs
```

Booru plumbing has single owners; change the rule there, not in a client:

- **Booru import rules** (post body, duplicate merge, display names, progress text, pacing/back-off): [browser-extension/booru-import-rules.js](browser-extension/booru-import-rules.js), loaded by the extension and imported by the web app through `frontend/src/remote/importRules.js`. Both suites run `browser-extension/booru-import-rules.fixture.json`.
- **Tag-name mapping between boorus**: Danbooru → e621 in [backend/app/services/e621_names.py](backend/app/services/e621_names.py) (also owns the name-order swap the import direction uses in `site_imports._danbooru_spellings`) and, browser-side for the aggregated search, `frontend/src/remote/e621Names.js`. Danbooru → Sankaku stays in `site_imports.sankaku_name_for`.

---

## The auto-tagging system

Everything lives in the [backend/app/services/auto_tagger/](backend/app/services/auto_tagger/) package and is exposed by [backend/app/routers/auto_tags.py](backend/app/routers/auto_tags.py) under `/api/auto-tags`.

The package's `__init__` re-exports every name, so `from app.services.auto_tagger import X` keeps working. A part looks up what it imported in its own globals, so a test patches the part that makes the call (`mock.patch("app.services.auto_tagger.dispatch.runtime_available")`); patching the package path only reaches callers outside the package. State that is rebound at runtime (`_download_job`, `_load_job`, CUDA flags) lives in `__init__` and the parts read it as `_at.<name>`. Parts, in import order (each imports only earlier ones):

- `core` — constants, `MODEL_REGISTRY`, `AutoTagOptions` / `AutoTagResult`, `_gpu_work_lock`, `normalize_tag`, `safety_from_rating`, and the UI registry (`MODEL_FLAGS`, `PROFILE_MODEL_DEFAULTS`, `model_registry_payload`)
- `runtime` — torch / ONNX / llama.cpp detection, `_prepare_onnx_cuda_runtime`, `_create_onnx_session`
- `semantic` — prompts, semantic parsing, `merge_with_existing`, tag filters
- `options` — `load_options` / `validate_options`, tokens
- `cache` — `model_cache_status`, HF cache dirs, GGUF paths
- `downloads` — `start_model_download`, `_run_model_download_job`, `_download_lock`
- `media_io` — tensors, frames/audio, `_cached_file*`, tag vocabularies
- `media_taggers` — OCR, Whisper, Qwen, Qwen GGUF taggers and singletons
- `onnx_taggers` — WD, PixAI, Camie, CL taggers and singletons
- `models` — `status`, `_tagger_for_model`, `runtime_available`, `_model_runtime_providers`, `_onnx_runtime_info`, the load queue, `_new_load_job`, unload/delete/download
- `dispatch` — `tag_media`, `_optional_image_results`, `_run_optional`, `_combine_results`, video

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

Backend ([backend/app/services/auto_tagger/](backend/app/services/auto_tagger/)):
1. `core.py`: `MODEL_REGISTRY` entry (id, name, repoId, purpose, downloadSize, vramRequirement, `allowPatterns` / `requiredFiles` / `requiredFileKinds`, plus `expectedTotalBytes` and `downloadAll: False` for large or gated repos).
2. A tagger class + module-level singleton in `onnx_taggers.py` (ONNX) or `media_taggers.py` (others).
3. `core.py`: `AutoTagOptions.<model>Enabled` field (defaults to `False`).
4. `models.py`: `_tagger_for_model()` branch.
5. `models.py`: `runtime_available()` branch, `_model_runtime_providers()` branch, and the `<model>Providers` key in `_onnx_runtime_info()` for ONNX models.
6. `dispatch.py`: `_optional_image_results()` — run it when the flag is set; add to the `visual_enrichers` condition in `_tag_video_with_enrichers()` if it should also see sampled video frames.
7. `models.py`: `_new_load_job()` load-time estimate.

The model registry (one owner, served at `GET /api/auto-tags/registry` by `model_registry_payload()`):
8. `core.py`: the model's `_MODEL_PIPELINE` row (its `AutoTagOptions` flag key, pipeline label and description, runtime packages). A new flag also gets a `MODEL_FLAGS` row, and a value in each `PROFILE_MODEL_DEFAULTS` stack. Nothing else reads a hand-copied model list: `settings.py`'s `_normalize_ai_model_default_stack()` uses `MODEL_FLAG_KEYS`; the Settings, post, upload and batch views derive everything from [useAiModelRegistry.js](frontend/src/composables/useAiModelRegistry.js); the extension's [upload-ai-models.js](browser-extension/upload-ai-models.js) fetches the registry.
9. Regenerate the two copies the clients ship, which `test_model_registry_is_served_once_for_every_surface` compares with the server: [aiModelRegistry.fixture.json](frontend/src/composables/aiModelRegistry.fixture.json) (the web tests' mock) and the `/* registry:start */ ... /* registry:end */` fallback in `upload-ai-models.js` (used when the server is unreachable). Both are `json.dumps(model_registry_payload(), indent=2)`.
10. Only for a semantic backend: its wording in `semanticBackendDescription()` in [useSettingsAiModels.js](frontend/src/composables/useSettingsAiModels.js).
11. Rebuild `frontend/dist`.

Tests (`tests/test_auto_tags_*.py`, split by area; the API classes share `AutoTagApiTestCase` from [tests/auto_tag_support.py](tests/auto_tag_support.py)):
12. Add the id to the model-listing / download-all assertions in `test_auto_tags_api_models.py` and add a tagging test to `test_auto_tags_runtime.py` mirroring the existing `pixai` / `cl` cases.

Docs: mention the model in [README.md](README.md)'s auto-tagging section.

---

## Gotchas

- Long-running greps over the repo root are slow because `venv/`, `node_modules/`, `build-venv/`, and `models/` are large — prefer the Grep tool (ripgrep, respects gitignore) over shelling out to `grep -r`.
- `data/`, `config/`, `logs/`, `models/` are gitignored runtime state — never commit them, and never assume their contents exist.
- The tests import `app.*` by inserting `backend/` on `sys.path`, so they must be run from `tests/`.
- Windows is the primary dev platform here, but everything must keep working on Linux/macOS and inside the PyInstaller build ([nekobooru.spec](nekobooru.spec)).
- The owner's own instance runs on port 8772. A dev server or backend you start for testing must use another port and a throwaway data dir (point every `NEKO_*` path at a temp folder). The dev proxy defaults to 8772, so point a test frontend elsewhere with `VITE_BACKEND` in `frontend/.env.local` or `frontend/.env.development.local` (gitignored by Vite's `*.local` convention) and delete it afterwards.
