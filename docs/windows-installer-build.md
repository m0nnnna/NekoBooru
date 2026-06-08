# Building the Windows Installer

This document is the practical build/runbook for producing the NekoBooru Windows setup wizard.

The Windows installer is built with Inno Setup. It packages the PyInstaller app, the worker backend source used by the packaged local AI runtime, the AI runtime installer scripts, and the default installer settings flow.

## Outputs

The build produces:

```text
dist/nekobooru-binary/nekobooru.exe
dist/nekobooru-binary/README.txt
dist/nekobooru-binary/SHA256SUMS.txt
dist/nekobooru-binary/start-neko.bat
dist/installer/NekoBooruSetup-<version>.exe
```

The normal installer output is:

```text
dist/installer/NekoBooruSetup-4.1.0.exe
```

Override the installer version with:

```powershell
.\build-installer.ps1 -Version 4.1.1
```

## Prerequisites

Install these on the Windows build machine:

- Python 3.12 recommended.
- Node.js and npm.
- Inno Setup 6.
- Git for Windows.
- PowerShell.

`build-installer.ps1` looks for `ISCC.exe` on `PATH` and in these common locations:

```text
%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
%LOCALAPPDATA%\Programs\Inno Setup 5\ISCC.exe
%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
%ProgramFiles%\Inno Setup 6\ISCC.exe
%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe
%ProgramFiles%\Inno Setup 5\ISCC.exe
```

## One-command Build

From the repository root:

```powershell
.\build-installer.bat
```

That wrapper runs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-installer.ps1
```

If `dist\nekobooru-binary\nekobooru.exe` does not exist, the installer build automatically runs:

```powershell
.\build-binary.bat
```

## Explicit Build Steps

Use these steps when debugging or preparing a release.

1. Build the packaged binary:

```powershell
.\build-binary.bat
```

This script:

- Installs frontend dependencies if `frontend\node_modules` is missing.
- Runs `npm run build` in `frontend`.
- Creates or reuses `build-venv`.
- Installs `backend\requirements.txt` and PyInstaller into `build-venv`.
- Generates `frontend\public\favicon.ico`.
- Runs `pyinstaller nekobooru.spec --noconfirm --clean`.
- Copies the packaged executable to `dist\nekobooru-binary`.

2. Build the installer:

```powershell
.\build-installer.bat
```

This compiles:

```text
packaging/windows/nekobooru.iss
```

3. Confirm the output:

```powershell
Get-ChildItem .\dist\installer\NekoBooruSetup-*.exe |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 FullName, Length, LastWriteTime
```

## Installer Defaults

The installed app is intentionally configured to avoid the dev server ports:

```text
Installed backend/API/UI:        127.0.0.1:8773
Installed local AI worker:       127.0.0.1:8774
Dev frontend/CORS reference:     127.0.0.1:5174
```

The dev repo can keep using:

```text
Dev backend:  127.0.0.1:8772
Dev frontend: 127.0.0.1:5173
```

The installed UI is served from the backend/API port. By default, open the installed app at `http://127.0.0.1:8773/`, not `5174`.

The `5174` value is only a CORS/dev-reference port for an optional Vite frontend pointed at the installed backend during debugging. It is not started by the installer.

To run a dev frontend against the installed backend:

```powershell
$env:NEKO_FRONTEND_PORT = "5174"
$env:VITE_BACKEND = "http://127.0.0.1:8773"
.\start-frontend.bat
```

Without `VITE_BACKEND`, the Vite frontend defaults to the source/dev backend at `http://127.0.0.1:8772`.

The installer wizard exposes port fields. Rerunning the installer can reconfigure these values.

Settings are written to:

```text
%LOCALAPPDATA%\NekoBooru\config\settings.json
```

## Packaged App Tray

The Windows packaged app starts without a console window and adds a system tray icon when the desktop shell is available.

Tray menu:

```text
Open NekoBooru
Shut Down NekoBooru
```

`Shut Down NekoBooru` requests a graceful server shutdown and also stops the packaged local AI worker through the normal process cleanup path.

The windowed app does not rely on console streams for Uvicorn logging. Server logs are written to:

```text
%LOCALAPPDATA%\NekoBooru\logs\nekobooru-server.log
```

During install, upgrade, and uninstall, setup signals the same packaged-app shutdown event, waits briefly, then prompts before force-closing only the installed `{app}\nekobooru.exe` process if it is still running. Source/dev NekoBooru processes from a checkout are not targeted by this fallback.

## AI Runtime Behavior

The base installer does not bundle Torch, CUDA wheels, or model weights.

During install, the wizard can install one of these runtime profiles:

- Skip AI setup.
- Local CPU AI.
- Local NVIDIA GPU AI for modern CUDA/Torch.
- Local legacy NVIDIA GPU AI for older CUDA compatibility.
- Remote/server AI.

For local CPU/GPU profiles, the installer runs:

```text
install-ai.ps1
```

The managed AI venv is installed at:

```text
%LOCALAPPDATA%\NekoBooru\runtimes\python-ai
```

The install receipt is:

```text
%LOCALAPPDATA%\NekoBooru\runtimes\python-ai\nekobooru-ai-runtime.json
```

The AI install log is:

```text
%LOCALAPPDATA%\NekoBooru\logs\install-ai.log
```

Model weights are still downloaded later from NekoBooru Settings. They are not bundled in the installer.

## Packaged Local AI Worker

The frozen `nekobooru.exe` does not run CUDA Torch in-process. For packaged local AI installs, the main app starts a hidden local worker process using the managed AI venv.

Default flow:

```text
nekobooru.exe on 127.0.0.1:8773
  -> starts worker-backend/run_prod.py with python-ai
  -> worker listens on 127.0.0.1:8774
  -> main app forwards AI tagging calls to the worker
```

Worker logs:

```text
%LOCALAPPDATA%\NekoBooru\logs\local-ai-worker.out.log
%LOCALAPPDATA%\NekoBooru\logs\local-ai-worker.err.log
```

The installer includes the backend source under:

```text
{app}\worker-backend
```

That source is used only by the local AI worker.

## Update Source Defaults

The installer has an update-source page. Defaults:

```text
Owner:   m0nnnna
Repo:    NekoBooru
Channel: stable
```

For fork testing, set the owner/repo to the fork during install or reconfigure by rerunning the installer.

The app writes update settings to:

```json
{
  "updates": {
    "owner": "m0nnnna",
    "repo": "NekoBooru",
    "channel": "stable",
    "autoCheck": true,
    "autoDownload": false
  }
}
```

## Smoke Test

After building and installing:

1. Launch NekoBooru from the installer finish page or Start Menu.
2. Open:

```text
http://127.0.0.1:8773/
```

3. Check health:

```powershell
Invoke-RestMethod http://127.0.0.1:8773/api/health
```

Expected:

```json
{
  "status": "ok",
  "service": "NekoBooru"
}
```

4. If local AI was selected, check the worker:

```powershell
Invoke-RestMethod http://127.0.0.1:8774/api/health
```

5. Check AI runtime status:

```powershell
$status = Invoke-RestMethod http://127.0.0.1:8773/api/auto-tags/status
$status.remote.reachable
$status.remote.worker.torch.version
$status.remote.worker.torch.cudaAvailable
$status.remote.worker.onnx.availableProviders
```

For a working local GPU install, expect:

```text
remote.reachable = True
torch.version = 2.11.0+cu128 or the installed CUDA build
torch.cudaAvailable = True
onnx providers include CUDAExecutionProvider
```

The main frozen process may still report a Torch DLL error in raw diagnostics. That is expected for packaged local AI because the main process intentionally offloads AI to the local worker. The UI should prefer the worker status.

## Reconfigure, Repair, and Upgrade

Run the same installer again to:

- Change ports.
- Change update source.
- Change AI runtime profile.
- Repair/reinstall the selected AI runtime with the installer task:

```text
Repair/reinstall selected AI runtime even if it already looks installed
```

The installer writes settings first, then optionally runs the AI runtime installer.

## Uninstall

The Inno Setup installer creates the normal Windows uninstall entry:

```text
Settings -> Apps -> Installed apps -> NekoBooru -> Uninstall
```

The default uninstall removes the installed app directory and keeps user data under:

```text
%LOCALAPPDATA%\NekoBooru
```

During interactive uninstall, the wizard asks whether to review cleanup choices.

If cleanup is skipped, these remain:

- Posts/database.
- Settings.
- Logs.
- Downloaded model weights.
- Optional AI runtime venv, including Torch/CUDA Python wheels.

If cleanup is enabled, the wizard offers:

```text
Delete ALL user data
```

Removes:

```text
%LOCALAPPDATA%\NekoBooru
```

This deletes posts/database, settings, logs, downloaded model weights, and AI runtimes.

If full cleanup is declined, the wizard separately offers:

```text
Delete optional AI runtime
```

Removes:

```text
%LOCALAPPDATA%\NekoBooru\runtimes\python-ai
```

This removes the managed Python AI environment, including Torch/CUDA wheels, but keeps posts/settings/model weights.

```text
Delete downloaded AI model weights
```

Removes:

```text
%LOCALAPPDATA%\NekoBooru\models
```

This removes model weights but keeps posts/settings and the AI runtime.

Silent uninstall keeps user data and AI runtimes. It only removes the installed app files.

## Common Failures

### Inno Setup Not Found

Error:

```text
Inno Setup compiler was not found.
```

Fix:

- Install Inno Setup 6.
- Add `ISCC.exe` to `PATH`, or install it in one of the standard locations listed above.

### Frontend Build Fails

Run:

```powershell
cd frontend
npm install
npm run build
```

Then rerun:

```powershell
cd ..
.\build-binary.bat
```

### PyInstaller Build Fails

Clear the build output and rerun:

```powershell
Remove-Item .\build -Recurse -Force
Remove-Item .\dist\nekobooru.exe -Force -ErrorAction SilentlyContinue
.\build-binary.bat
```

Do not delete user data under `%LOCALAPPDATA%\NekoBooru` while debugging builds.

### Installed App Uses the Wrong Port

Rerun the installer and set the port fields. The settings file should contain:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8773,
    "frontendPort": 5174
  }
}
```

### Local AI Shows CPU Only

Check the worker status, not only the main process status:

```powershell
$status = Invoke-RestMethod http://127.0.0.1:8773/api/auto-tags/status
$status.remote
```

If `remote.reachable` is false:

- Confirm the local worker is listening on backend port + 1.
- Check `local-ai-worker.err.log`.
- Confirm the selected AI profile is not `skip` or `remote`.

If the worker is reachable but CUDA is false:

- Check `%LOCALAPPDATA%\NekoBooru\logs\install-ai.log`.
- Run the installer again and enable the AI runtime repair task.
- Confirm the GPU driver supports the selected CUDA/Torch profile.

## Release Checklist

Before publishing an installer:

- `git status --short` is clean except intentional build artifacts.
- `npm run build` succeeds in `frontend`.
- `.\build-binary.bat` succeeds.
- `.\build-installer.bat` succeeds.
- Fresh install opens `http://127.0.0.1:8773/`.
- Re-run installer can change ports.
- Local AI profile starts worker on `backend port + 1`.
- Settings shows worker GPU status when CUDA is installed.
- `dist\installer\NekoBooruSetup-<version>.exe` is attached to the GitHub Release.
