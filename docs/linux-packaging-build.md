# Linux Packaging Build

NekoBooru supports three Linux packaging paths:

- DEB for Debian/Ubuntu-like systems.
- AppImage for portable cross-distro installs.
- Flatpak manifest for sandboxed desktop distribution.

## DEB

Build:

```bash
./build-deb.sh 4.1.0
```

Output:

```text
dist/nekobooru_4.1.0_all.deb
```

Install:

```bash
sudo dpkg -i dist/nekobooru_4.1.0_all.deb
sudo apt-get install -f
```

Run:

```bash
nekobooru
```

Reconfigure ports, AI runtime choice, update source, and browser integration:

```bash
nekobooru-configure
```

Repair the core venv and native host registration:

```bash
nekobooru-repair
```

Repair AI runtime too:

```bash
nekobooru-repair --ai --gpu
```

Use a specific installed Python when testing multiple distro Python versions:

```bash
NEKO_PYTHON=/usr/bin/python3.12 nekobooru
NEKO_AI_PYTHON=/usr/bin/python3.12 nekobooru-configure
```

Remove app package while preserving user data:

```bash
sudo apt remove nekobooru
```

Remove current user's data intentionally:

```bash
nekobooru-uninstall-user-data
```

## User Data

Packaged Linux installs keep `/opt/nekobooru` immutable and store mutable data under XDG paths:

```text
~/.config/nekobooru/settings.json
~/.local/share/nekobooru
~/.cache/nekobooru
~/.local/state/nekobooru/logs
```

## Python And AI Runtime Linking

Installed Linux builds keep two user-owned virtual environments:

```text
~/.local/share/nekobooru/runtimes/python-core
~/.local/share/nekobooru/runtimes/python-ai
```

The core launcher selects `NEKO_CORE_PYTHON`, then `NEKO_PYTHON`, then `python3` from PATH. It requires Python 3.10 or newer, creates the core venv from that interpreter, and writes:

```text
~/.local/share/nekobooru/runtimes/python-core/.nekobooru-core-runtime.json
```

The AI installer selects `NEKO_AI_PYTHON`, then `NEKO_PYTHON`, then `python3` from PATH. It installs into the AI venv and writes:

```text
~/.local/share/nekobooru/runtimes/python-ai/.nekobooru-ai-runtime.json
```

The AI receipt records the selected Python executable, venv Python, target profile, requirements file, and installed torch variant. If the selected Python changes later, the AI venv is rebuilt so CPU/CUDA PyTorch wheels stay linked to the intended interpreter.

AI runtime profiles:

```text
cpu       backend/requirements-tagger-cpu.txt
legacy    backend/requirements-tagger-legacy.txt
gpu       backend/requirements-tagger.txt
```

GPU installs verify that a CUDA tensor operation can run. Auto-detected installs fall back from standard CUDA to legacy CUDA to CPU when the selected CUDA wheel cannot launch a kernel on the machine.

## Native Browser Host

User-level native messaging registration:

```bash
/opt/nekobooru/browser-extension/native-host/install-native-host.sh CHROMIUM_EXTENSION_ID
```

The script writes manifests for Chrome, Chromium, Brave, Edge, and Firefox:

```text
~/.config/google-chrome/NativeMessagingHosts/com.nekobooru.launcher.json
~/.config/chromium/NativeMessagingHosts/com.nekobooru.launcher.json
~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.nekobooru.launcher.json
~/.config/microsoft-edge/NativeMessagingHosts/com.nekobooru.launcher.json
~/.mozilla/native-messaging-hosts/com.nekobooru.launcher.json
```

Chromium browsers require the extension ID in `allowed_origins`.

## AppImage

Requires `appimagetool` on PATH.

```bash
./build-appimage.sh 4.1.0
```

Output:

```text
dist/NekoBooru-4.1.0-<arch>.AppImage
```

## Flatpak

Requires `flatpak-builder`.

```bash
./build-flatpak.sh
```

Output:

```text
dist/NekoBooru.flatpak
```

The Flatpak manifest is:

```text
packaging/linux/flatpak/io.github.nekobooru.NekoBooru.yml
```
