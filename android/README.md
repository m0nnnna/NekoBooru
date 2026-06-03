# NekoBooru Android

Offline-first Android client for a self-hosted [NekoBooru](../README.md) server.
Browse, add, tag, edit, and delete media on your phone; it syncs both directions
with the home server whenever the server is reachable (LAN).

> **Status:** Feature-complete for the core loop — online/offline browse, add,
> tag, edit, delete, favorite, pools, two-way sync, background auto-sync, a
> "Share to NekoBooru" target, and configurable offline retention. In-app video
> playback (Media3) is the remaining known gap. See `RESUME.md` for details.

## Stack
- Kotlin + Jetpack Compose (Material 3)
- Retrofit + OkHttp + kotlinx-serialization (talks to the backend `/api`)
- Coil (image/GIF thumbnails)
- Room (offline cache), WorkManager (background sync)
- _(coming next: Media3 for in-app video playback)_

## Requirements
- Android Studio (Ladybug or newer) — bundles a compatible JDK (17+).
- Android SDK with **platform android-35** and **build-tools 34.0.0** installed.
- Backend running with the sync layer (`/api/sync/changes`, `/api/sync/push`).

## Build & run
Open the `android/` folder in Android Studio and Run, or build the APK from the
command line. The helper scripts resolve Android Studio's bundled JDK and the
Android SDK for you:

```powershell
# Windows (PowerShell) — debug APK; add -Install, -Release, or -Clean as needed.
./build-apk.ps1
./build-apk.ps1 -Install        # build + install on a connected device/emulator
./build-apk.ps1 -Release        # unsigned release APK

# Windows (cmd)
build-apk.bat                   # debug APK
build-apk.bat install           # build + install
```

Or invoke Gradle directly (set `JAVA_HOME` to a JDK 17+ first):

```bash
./gradlew assembleDebug                 # builds app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug                  # install on a connected device/emulator
```

The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk`.
`local.properties` (gitignored) holds the SDK path (`sdk.dir=...`); Android Studio
creates it automatically on first open, and the build scripts fall back to it.

## Pointing the app at your server
Open **Settings** (gear icon, top-right of the gallery) and set the **Server URL**:
- **Emulator** → `http://10.0.2.2:8000` (the emulator's alias for your dev machine; this is the default).
- **Physical phone on home Wi-Fi** → `http://<your-server-LAN-IP>:8000` (e.g. `http://192.168.0.2:8000`).

Cleartext HTTP is allowed (`usesCleartextTraffic`) because this is a LAN-only,
no-auth deployment. Don't expose the server publicly without adding auth/TLS.
