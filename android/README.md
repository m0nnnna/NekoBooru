# NekoBooru Android

Offline-first Android client for a self-hosted [NekoBooru](../README.md) server.
Browse, add, tag, edit, and delete media on your phone; it syncs both directions
with the home server whenever the server is reachable (LAN).

> **Status:** Foundation (step 2 of the build plan) — online browse of the server
> gallery. Offline cache, the sync engine, upload/tag, and the remaining screens
> land in subsequent increments. See the plan for the full roadmap.

## Stack
- Kotlin + Jetpack Compose (Material 3)
- Retrofit + OkHttp + kotlinx-serialization (talks to the backend `/api`)
- Coil (image/GIF thumbnails)
- _(coming next: Room for the offline cache, WorkManager for background sync, Media3 for video)_

## Requirements
- Android Studio (Ladybug or newer) — bundles a compatible JDK (17+).
- Android SDK with **platform android-35** and **build-tools 34.0.0** installed.
- Backend running with the sync layer (`/api/sync/changes`, `/api/sync/push`).

## Build & run
Open the `android/` folder in Android Studio and Run, or from the command line:

```bash
# JAVA_HOME must point at a JDK 17+ (Android Studio's bundled JBR works).
./gradlew assembleDebug                 # builds app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug                  # install on a connected device/emulator
```

`local.properties` (gitignored) holds the SDK path (`sdk.dir=...`); Android Studio
creates it automatically on first open.

## Pointing the app at your server
On first launch, set the **Server URL** field:
- **Emulator** → `http://10.0.2.2:8000` (the emulator's alias for your dev machine; this is the default).
- **Physical phone on home Wi-Fi** → `http://<your-server-LAN-IP>:8000` (e.g. `http://192.168.0.2:8000`).

Cleartext HTTP is allowed (`usesCleartextTraffic`) because this is a LAN-only,
no-auth deployment. Don't expose the server publicly without adding auth/TLS.
