# Desktop Packaging Stages for EXE and DEB

This plan makes NekoBooru packageable without bundling the CUDA/PyTorch/model stack into the base app. The installer should ship a small, stable core and then offer explicit AI runtime profiles that can be installed locally, on a remote server, or skipped entirely.

## Goals

- Build a Windows EXE installer and Linux DEB that can run the core booru without AI.
- Keep CUDA wheels, Torch, ONNX Runtime GPU, Transformers, and model weights out of the base installer.
- Let users choose where AI runs: bundled local backend, separate server/GPU worker, CPU-only local mode, or disabled.
- Support model/runtime installation after first launch with progress, retry, resume, and clear failure logs.
- Keep paths portable: no developer machine paths, no source-checkout assumptions, and no required admin rights for normal user installs.

## Non-goals

- Do not bundle Hugging Face model weights into the app installer.
- Do not install NVIDIA drivers automatically.
- Do not require AI packages for the browser extension, basic uploads, search, browsing, or tag editing.

## Current Repo Baseline

- `nekobooru.spec` already excludes `torch`, `onnxruntime`, `transformers`, `huggingface_hub`, `safetensors`, and related AI dependencies from the PyInstaller binary.
- `backend/requirements.txt` is the core runtime.
- `backend/requirements-tagger.txt` is the current NVIDIA/CUDA profile.
- `backend/requirements-tagger-legacy.txt` supports older Pascal NVIDIA GPUs through CUDA 12.6 wheels.
- `backend/requirements-tagger-cpu.txt` is the CPU-only AI profile.
- `install-ai.ps1` already detects GPU capability and installs one of the GPU, legacy GPU, or CPU profiles into a venv.
- Browser auto-start depends on the native messaging host under `browser-extension/native-host`.

## Stage 1: Runtime Layout and Path Discipline

Create a packaged runtime layout that works the same in source, EXE, and DEB installs.

Windows target layout:

```text
%LOCALAPPDATA%\NekoBooru\
  config\
  data\
  logs\
  models\
  runtimes\
    python-ai\
```

Linux user install layout:

```text
~/.config/nekobooru/
~/.local/share/nekobooru/
~/.cache/nekobooru/
~/.local/state/nekobooru/logs/
```

Linux system package layout:

```text
/opt/nekobooru/
/var/lib/nekobooru/
/var/log/nekobooru/
```

Implementation tasks:

- Add one runtime-path resolver used by backend, packaged launcher, model downloader, yt-dlp cookies, and native host installer.
- Move generated data, config, caches, logs, downloaded wheels, and model weights outside the app install directory.
- Add a startup diagnostics endpoint that reports app path, data path, config path, model cache path, Python executable, ffmpeg, yt-dlp, Torch, CUDA, ONNX providers, and loaded AI models.
- Make packaged startup fail soft when AI runtime is missing: the app should run, settings should show "AI runtime not installed", and AI buttons should explain how to install it.

Acceptance:

- Fresh install opens the UI with no AI packages installed.
- Upload/search/browse/tag editing work without Torch or ONNX Runtime.
- Diagnostics show all resolved paths and do not include local developer paths.

## Stage 2: Core App Package

Package only the stable booru runtime.

Windows EXE tasks:

- Build frontend with `npm run build`.
- Build the backend/core bundle from `nekobooru.spec`.
- Include `frontend/dist` in the bundle.
- Include core Python dependencies from `backend/requirements.txt`.
- Include or discover `ffmpeg` and `ffprobe`.
- Exclude AI dependencies exactly as the current PyInstaller spec does.
- Add a launcher that starts the backend and opens the local client.

Linux DEB tasks:

- Install app files under `/opt/nekobooru`.
- Provide a `nekobooru` launcher command.
- Provide a `.desktop` entry.
- Use XDG user paths by default.
- Optional: install a systemd user service for auto-start.

Acceptance:

- Windows EXE and Linux DEB can install, launch, stop, and uninstall cleanly.
- The app works offline for non-AI features after installation.
- Uninstall does not delete user media unless explicitly requested.

## Stage 3: AI Runtime Installer Profiles

The installer should expose AI as a second-stage install, not as part of the base package.

Profiles:

| Profile | Location | Purpose | Installs |
| --- | --- | --- | --- |
| No AI | Client/core only | Browse/upload/tag manually | Core app only |
| Local CPU AI | Same machine | Slow but simple auto-tagging | `requirements-tagger-cpu.txt` |
| Local NVIDIA AI | Same machine | Fast local auto-tagging | `requirements-tagger.txt` or legacy profile |
| Local legacy NVIDIA AI | Same machine | Pascal/GTX 10-series support | `requirements-tagger-legacy.txt` |
| Remote/server AI | Separate GPU machine | Keep client light and use a server/worker | Core client plus remote AI endpoint settings |

Installer UI tasks:

- Add an "AI runtime" page with these choices:
  - Skip AI for now.
  - Install CPU AI locally.
  - Auto-detect NVIDIA GPU and install best local AI runtime.
  - Install legacy NVIDIA runtime.
  - Connect to an existing NekoBooru AI server/worker.
- Show expected download size, disk size, and VRAM estimate before installing.
- Show that model weights are downloaded later from Settings, not bundled in the installer.
- Preserve the current `install-ai.ps1` auto-detection behavior, but move it behind a UI/CLI installer command.

Runtime install tasks:

- Create a managed AI venv under the runtime data directory, not inside the source tree.
- Download wheels with progress and resumable retry.
- Pin runtime manifest entries for Torch/CUDA/ONNX/Transformers versions.
- Verify installed runtime by importing Torch/ONNX Runtime and running a tiny CUDA kernel when applicable.
- Store a JSON install receipt with profile, package versions, install date, CUDA availability, and verification status.

Acceptance:

- Installing AI after the app is installed does not require rebuilding the EXE/DEB.
- Already-installed compatible runtimes are detected and not downloaded again.
- Wrong CUDA runtime can be repaired without reinstalling the whole app.

## Stage 4: Server AI and Client AI Modes

The installer needs to distinguish between the machine that stores/runs the booru and the machine that runs AI.

Client/core mode:

- Installs the UI, backend API, database, media library, extension native host, and yt-dlp support.
- Does not install CUDA wheels.
- Can point AI requests at a remote worker.

Server AI mode:

- Installs the AI runtime and model cache.
- Can run on the same machine as the booru or as a GPU worker.
- Provides a health endpoint with runtime/profile/model status.
- Supports auth/token configuration before accepting remote requests.

Hybrid local mode:

- Installs core app and AI runtime on the same machine.
- Uses local model cache and local GPU/CPU.

Extension implications:

- Browser extension "Start NekoBooru" should start the client/core app.
- AI preview/upload should use the configured AI endpoint from the app, whether local or remote.
- Extension should show "booting NekoBooru", then retry the original action after the backend is healthy.

Acceptance:

- A lightweight client install can use a remote GPU server for AI tagging.
- A server AI install can be upgraded independently from the client.
- Extension behavior is identical once the configured backend is healthy.

## Stage 5: Model Downloader and First-run Experience

Keep model weights separate from both app and AI runtime packages.

Tasks:

- Reuse the Settings model download UI as the canonical model installer.
- Add first-run prompts:
  - "Core app ready."
  - "Install AI runtime?"
  - "Download models?"
- Support per-model download, download all, retry failed, verify downloaded, and unload loaded models.
- Surface model sizes, VRAM estimates, required runtime profile, and whether the model is currently loaded.
- Respect Hugging Face token storage for gated/private models.

Acceptance:

- Core app installer remains small.
- Users can install CUDA runtime without immediately downloading model weights.
- Users can download model weights without changing app package version.

## Stage 6: Windows Installer

Recommended path: PyInstaller artifact plus an installer wrapper such as Inno Setup, NSIS, or WiX.

Windows installer tasks:

- Install the core app into `%LOCALAPPDATA%\Programs\NekoBooru` for user install or `Program Files` for machine install.
- Create Start Menu shortcuts.
- Register URL/protocol handler only if needed.
- Register native messaging host for Brave and Chrome using user-level registry keys.
- Add optional "Install AI runtime now" checkbox that opens the AI runtime page after first launch.
- Add optional "Start with Windows" toggle.
- Add repair and uninstall entries.

Important:

- Do not put CUDA wheels inside the EXE installer.
- Do not write model weights under `Program Files`.
- Do not assume the source-tree `venv` exists.

Acceptance:

- A non-admin Windows user can install and run the core app.
- Native host registration works for Brave/Chrome after extension reload.
- AI runtime installation can be launched from Settings later.

## Stage 7: Linux DEB Installer

Recommended path: Debian package for the core app plus post-install helper scripts.

DEB tasks:

- Install immutable app files under `/opt/nekobooru`.
- Add `/usr/bin/nekobooru` launcher.
- Add desktop entry and icon.
- Use XDG user directories for normal app data.
- Add optional systemd user unit for background start.
- Install native messaging host JSON to supported browser locations:
  - Brave user/global location.
  - Chrome/Chromium user/global location.
- Provide `nekobooru ai install --cpu`, `--gpu`, `--legacy`, and `--server` commands.

CUDA policy:

- Detect NVIDIA driver and CUDA compatibility.
- Install Python CUDA wheels into the managed AI venv.
- Do not apt install GPU drivers automatically.
- If GPU validation fails, offer legacy or CPU fallback.

Acceptance:

- DEB installs and removes cleanly on Debian/Ubuntu-like systems.
- Core app runs without AI packages.
- AI install logs give actionable failure messages.

## Stage 8: Updates, Rollback, and Version Control

Keep app updates, AI runtime updates, yt-dlp updates, and model updates independent.

Tasks:

- Add a runtime manifest file with versions and hashes for optional AI profiles.
- Add "Update app", "Update AI runtime", "Update yt-dlp", and "Update models" as separate concepts.
- Snapshot settings before runtime upgrades.
- Backup the database before migrations.
- Keep previous AI runtime install receipt for rollback.
- Allow pinned yt-dlp versions because some sites break across releases.

Acceptance:

- Updating the app does not reinstall CUDA wheels.
- Updating CUDA wheels does not modify the media library.
- Failed AI upgrades leave the previous runtime usable.

## Stage 9: Installer Upgrade Mode

The installer should support fresh install, upgrade install, repair install, and uninstall as separate flows.

Upgrade detection:

- Detect an existing install by app registry entry on Windows or package metadata on Linux.
- Detect existing user data through the runtime path resolver, not through hardcoded paths.
- Show installed version, target version, data path, model cache path, AI runtime profile, and extension/native host status.
- Warn before any migration that changes the database schema.

Windows upgrade tasks:

- Stop the running packaged backend before replacing files.
- Preserve `%LOCALAPPDATA%\NekoBooru\config`, `data`, `models`, `logs`, and `runtimes`.
- Replace only immutable app files under the install directory.
- Re-register native messaging host if the launcher path changed.
- Keep the existing AI runtime unless the user chooses "Upgrade AI runtime too".
- Offer repair actions:
  - Repair app files.
  - Repair native host.
  - Repair AI runtime.
  - Rebuild shortcuts/startup entry.

Linux DEB upgrade tasks:

- Let package manager replace `/opt/nekobooru` files.
- Preserve `/var/lib/nekobooru` or XDG user data.
- Run migrations on next app start, with backup first.
- Refresh desktop entry and native messaging host manifests.
- Do not reinstall AI wheels from `postinst` unless the user explicitly runs the AI installer command.

AI runtime upgrade policy:

- Treat AI runtime upgrades as opt-in because CUDA/Torch changes are large and can break older GPUs.
- Show currently installed Torch, CUDA build, ONNX Runtime providers, and target versions.
- Keep the previous install receipt before upgrade.
- If validation fails, offer rollback to previous runtime, legacy GPU, or CPU profile.

Acceptance:

- Installing a newer EXE/DEB over an older one preserves library data and settings.
- Upgrade can repair native host registration without reinstalling AI.
- Users can upgrade the app while keeping pinned yt-dlp, pinned AI runtime, and downloaded models.

## Stage 10: CI and Release Validation

Build and test release artifacts before publishing.

CI tasks:

- Windows build: frontend build, PyInstaller build, installer build.
- Linux build: frontend build, DEB package build.
- Smoke test installed app:
  - Starts backend.
  - Serves frontend.
  - Uploads image.
  - Searches tags.
  - Reports AI missing cleanly.
- Optional GPU validation job on a self-hosted NVIDIA runner.
- Generate checksums and release notes.

Acceptance:

- Release artifacts are reproducible enough to compare size and contents.
- No model weights or CUDA wheels appear in the base installer.
- Base installer smoke test passes without network.

## Stage 11: Security and Privacy Review

Packaging adds trust boundaries, especially around browser integration and downloaded code.

Tasks:

- Verify native messaging host manifest paths are generated per install and never point to source-tree paths.
- Validate downloaded wheel/model manifests before installing.
- Keep Hugging Face tokens and browser cookies in user config, not app install folders.
- Never expose local file paths through public API responses unless explicitly requested by the local extension/native host flow.
- Bind local backend to localhost by default.
- Require explicit configuration before allowing remote AI server access.

Acceptance:

- A default packaged install does not expose the library over LAN.
- Extension/native host paths survive app updates.
- Installer logs do not leak Hugging Face tokens or browser cookies.

## Suggested Implementation Order

1. Add runtime path resolver and diagnostics.
2. Make source, PyInstaller, and future DEB all use the same resolved paths.
3. Convert `install-ai.ps1` behavior into a cross-platform runtime installer command.
4. Add AI runtime install status and repair actions to Settings.
5. Build Windows EXE core package.
6. Wrap Windows EXE in an installer and register native host.
7. Add fresh install, upgrade install, repair install, and uninstall flows.
8. Build Linux DEB core package.
9. Add remote/server AI mode.
10. Add CI packaging smoke tests.
11. Add signed release/checksum workflow.

## Practical Installer Copy

Recommended wording for the AI choice screen:

```text
NekoBooru can run without AI. Auto-tagging requires a separate AI runtime and model downloads.

[ ] Core app only
[ ] Local CPU AI - slower, no NVIDIA GPU required
[ ] Local NVIDIA AI - fastest, downloads CUDA/PyTorch wheels
[ ] Local legacy NVIDIA AI - for older GTX 10-series GPUs
[ ] Remote/server AI - connect this client to another NekoBooru AI worker

Model weights are downloaded later from Settings.
```

This keeps the EXE/DEB realistic: the base package is stable and small, while heavyweight AI pieces are explicit, repairable, and upgradeable.
