# NekoBooru Android — Resume / Handoff

Self-contained context to continue building the offline-first Android client in a
fresh session. Branch: **`android-sync-feature`**.

---

## Status

| Part | What | State |
|---|---|---|
| **A** | Backend sync layer (FastAPI) | ✅ done, verified (21-assert smoke test), committed |
| **B2** | Android online browse | ✅ compiles, committed |
| **B3** | Room offline cache + sync **pull** | ✅ compiles, committed |
| **B4** | Outbox + Add screen + sync **push** (new posts) | ✅ compiles, committed |
| **B5** | Detail screen + edit/delete/favorite push | ✅ compiles, committed |
| **B6** | Sync pools (notes/comments deferred) | ✅ compiles |
| **B7** | WorkManager auto-sync + share target + retention | ✅ compiles |
| **B8** | Device UX pass (theme/icon/back/safety/offline) | ✅ compiles, on-device tested |
| **A2** | Backend: backfill sync_log for pre-existing libraries | ✅ smoke-tested |

The core loop (browse, add, edit, delete, favorite, pools, two-way sync,
background auto-sync, share target, retention) is functionally complete and now
runs on a real device.

**B8 — device UX pass** (from first real-device testing):
- **Theme** now matches the website palette (ported `frontend/src/App.vue` CSS vars)
  with a Light/Dark/System toggle in Settings (`AppThemeState` applies it live);
  dropped Material-You dynamic color. See `ui/Theme.kt`.
- **Launcher icon** is the pawprint from `favicon.svg` as an adaptive icon
  (`mipmap-anydpi-v26` + `drawable/ic_launcher_foreground.xml`).
- **Back navigation** fixed: `MainActivity` uses a `SnapshotStateList` back stack +
  `BackHandler` so back pops screens (only the root closes the app).
- **Safety filtering**: persisted `visibleSafety` + gallery chips (safe/sketchy/unsafe),
  applied in gallery and pool views.
- **Offline collection**: thumbnails for every synced post are cached locally on each
  sync (`localThumbPath`, DB **v4**) so the grid browses fully offline. Upserts now
  preserve local cache columns (previously a re-pull wiped them and re-downloaded).
- **Offline mirror policy** (`OfflinePolicy`: 50 / 100 / 500 most-recent / Everything):
  keeps the N newest posts' **full originals** on-device (Everything = whole media
  library, however large), evicting the rest. The heavy original download runs only in
  the background `SyncWorker` (`SyncManager.sync(downloadOriginals=true)`); the
  interactive "Sync" button stays fast (push/pull + thumbnails) and enqueues the worker.
  Settings shows the cached-original count. Resumable via on-disk existence checks, so a
  big mirror completes across successive background passes.

**A2 — sync_log backfill**: the change log only captured *new* writes, so a library
created before the sync layer had an empty `sync_log` and a fresh client's `since=0`
pull returned nothing. `init_db` now seeds one upsert per existing entity when the log
is empty (idempotent). See `backend/app/services/sync.py::backfill_sync_log_if_empty`.

---

## Build & verify (this machine)

No Gradle on PATH; use the committed wrapper with Android Studio's JDK. From PowerShell:

```powershell
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"        # JDK 21
$env:ANDROID_HOME="C:\Users\Kake\AppData\Local\Android\Sdk"
& "N:\scripts\nekobooru\android\gradlew.bat" -p "N:\scripts\nekobooru\android" assembleDebug --no-daemon
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`. In Android Studio just
open `android/` and Run (it uses its own JDK). Toolchain present: SDK platforms
34/35/36, build-tools 34.0.0 (pinned in `app/build.gradle.kts`), JDK 21.

Backend smoke test pattern (Part A), if backend changes again: point
`config/settings.json` `data_dir` at a temp folder, run an in-process
`TestClient(app)` test, then delete the temp config/data. Real `data/` must stay
untouched.

---

## Architecture cheat-sheet

**Backend sync API** (committed in Part A — `backend/app/routers/sync.py`):
- `GET /api/sync/changes?since=<cursor>&limit=N` → `{cursor, hasMore, changes:[{type,op,key,data?}]}`.
  Types: `post` (data = Post.to_dict incl. `deletedAt`, `tags`, `thumbUrl`…), `tag`,
  `pool` (data has `uuid`, `name`, `description`, `postSha256s[]`), `note`/`comment`
  (data has `uuid`, `postSha256`, fields), `favorite` (no data; op=upsert/delete).
- `POST /api/sync/push` → `{changes:[PushChange]}` → `{cursor, results:[{clientId,sha256,serverId,status}]}`.
  `status` ∈ created/deduped/updated/deleted/conflict/error. New posts go via
  `POST /api/uploads` (multipart) → `contentToken` → push.
- Stable keys: **post=sha256, tag=name, pool/note/comment=uuid, favorite=post sha256**.
- Conflict policy: last-write-wins by `updatedAt`; **client omits `updatedAt` on push so
  the phone's offline edit wins** (single-user intent).

**Android layers** (`android/app/src/main/java/com/nekobooru/app/`):
- `data/Dtos.kt` — `PostDto` mirrors Post.to_dict.
- `data/SyncDtos.kt` — `SyncChangesResponse`, `SyncChange`, `PushChangeDto`, `PushResponseDto`, `UploadTokenDto`, `PoolSyncDto`.
- `data/NekoBooruApi.kt` — Retrofit interface (+ streaming `download(@Url)`) + `ApiFactory` (Json public; `absoluteUrl()` resolves relative media URLs).
- `data/AppSettings.kt` — SharedPreferences; `serverUrl` (default `http://10.0.2.2:8000`), `retention`, `lastSyncedAt`.
- `data/db/Entities.kt` — `PostEntity` (PK sha256; `dirty`/`deleted`/`localMediaPath` + retention `localOriginalPath`/`lastAccessedAt`), `PoolEntity` (PK uuid; CSV members), `SyncStateEntity` (cursor), `PendingChangeEntity` (outbox; pool payload fields).
- `data/db/Daos.kt` — `PostDao`, `PoolDao`, `SyncStateDao`, `OutboxDao`.
- `data/db/NekoDatabase.kt` — Room DB (**version 3**, `fallbackToDestructiveMigration`).
- `data/SyncRepository.kt` — `pull()`, `push()`, `enqueueNewPost/Edit/Delete/Favorite()`, `enqueuePoolUpsert/Delete()`, `addPostToPool()`.
- `data/SyncManager.kt` — `sync(context)` = push→pull→stamp `lastSyncedAt`→retention; the one entry point all sync paths use.
- `data/RetentionManager.kt` — original-file caching/eviction per `Retention` policy; `fetchOriginal()` for on-demand viewing.
- `sync/SyncWorker.kt` + `sync/SyncScheduler.kt` — WorkManager periodic + one-shot background sync.
- `ui/` — `GalleryScreen`, `AddScreen`, `DetailScreen`, `PoolsScreen`, `PoolScreen`, `SettingsScreen` (+VMs), shared `PostThumb.kt`, `Theme.kt`.
- `NekoApp.kt` — Application; schedules periodic sync on start.
- `MainActivity.kt` — sealed `Screen { Gallery, Add(sharedUri?), Detail(sha), Pools, Pool(uuid), Settings }` state-based nav; handles the ACTION_SEND share intent.

**Key conventions / decisions:**
- New offline posts get a **placeholder** `PostEntity` keyed `pending-<clientId>` with
  `dirty=true` + `localMediaPath` so they show immediately; on successful push the
  placeholder is deleted and the canonical post (with thumbnail) arrives via `pull()`.
- `push()` then `pull()` on every "Sync"; cursor is NOT advanced to the push response
  (so our own post comes back once, bringing its server thumbnail).
- Pending posts disable edit/delete in detail until synced.
- A locally `dirty` pool is not overwritten by an incoming pull (queued client edit wins),
  mirroring the post LWW policy.
- Bumping the Room schema = bump `version` in `NekoDatabase` (destructive migration is on).

---

## Step 6 — sync pools ✅ (notes/comments deferred)

Pools are the worthwhile entity on a phone; notes/comments stayed niche and were
**deferred** (the pull still ignores `note`/`comment` types — see `applyChanges`).

**Data (Room, now v3):**
- `PoolEntity(uuid PK, serverId?, name, description?, createdAt?, updatedAt?, postSha256sCsv, dirty, deleted)`
  in `data/db/Entities.kt`; members stored as an ordered CSV (`PoolEntity.csv()` / `.postSha256s`).
- `PoolDao` in `data/db/Daos.kt` (observe/get/getAll/upsert/delete/markDeleted).
- `NekoDatabase` registers `PoolEntity`, `version = 3` (destructive migration).
- `PostEntity` also gained `localOriginalPath` + `lastAccessedAt` for step-7 retention,
  and `PendingChangeEntity` gained `uuid/name/description/postSha256sCsv` for queued pools.

**Sync** (`SyncRepository`):
- Pull: `applyChanges` `"pool"` branch decodes `PoolSyncDto` → `PoolEntity`; **skips
  clobbering a locally `dirty` pool** so a queued edit wins.
- Push: `"pool"` upsert/delete branches; clears `dirty`/removes the row on success.
- `PushChangeDto` extended with `uuid, name, description, postSha256(s), text, x, y, width, height`.
- New repo methods: `enqueuePoolUpsert`, `enqueuePoolDelete`, `addPostToPool`.

**UI:** `PoolsScreen`+VM (list + create/delete), `PoolScreen`+VM (grid filtered to
`postSha256s` in order), "Add to pool" dialog in `DetailScreen` (pick existing or
create new). `MainActivity` gained `Screen.Pools` / `Screen.Pool(uuid)`; reach Pools
from the gallery top-bar list icon. Shared thumbnail grid extracted to `ui/PostThumb.kt`.

**Verify:** create a pool on the web UI → Sync on phone → pool appears; create/modify
a pool on phone offline → Sync → shows on web.

---

## Step 7 — auto-sync + share target + retention ✅

All three sync paths now funnel through **`data/SyncManager.sync(context)`**
(push → pull → stamp `lastSyncedAt` → run retention), reused by the button, per-edit
best-effort syncs, and the worker.

**WorkManager auto-sync** (`sync/`):
- `work-runtime-ktx:2.9.1` added.
- `SyncWorker(CoroutineWorker)` → `SyncManager.sync`; `Result.retry()` on `IOException`.
- `SyncScheduler`: `ensureScheduled()` (unique periodic, 3h, `NetworkType.CONNECTED`,
  KEEP) called from the new `NekoApp` Application on start; `requestOneShot()` (unique,
  REPLACE) fired after each local change so offline edits flush on reconnect.
- Gallery top bar shows "Last synced …" from `AppSettings.lastSyncedAt`.

**Share target ("Share to NekoBooru"):** `AndroidManifest` `ACTION_SEND` intent-filter
(`image/*`, `video/*`); `MainActivity.extractSharedUri()` (Tiramisu-safe) routes a shared
`EXTRA_STREAM` straight into `Screen.Add(sharedUri)`, which calls `AddViewModel.onPicked`.

**Retention** (`data/RetentionManager.kt`, `AppSettings.retention`):
- `Retention ∈ {EVERYTHING, FAVORITES_POOLS (default), ON_DEMAND}`.
- After each pull, `run()` downloads/evicts **originals** under `filesDir/originals`
  (thumbnails stay Coil-cached): EVERYTHING fetches all; FAVORITES_POOLS keeps
  favorited+pooled and evicts the rest; ON_DEMAND pre-fetches nothing and LRU-evicts
  past `ON_DEMAND_CAP` (60) by `lastAccessedAt`.
- `fetchOriginal()` caches on view + touches access time; `DetailViewModel.localOriginal`
  feeds the detail `MediaPreview` (so favorited images open offline).
- New **`SettingsScreen`**+VM: server URL (moved off the gallery), retention radio,
  "Sync now" + status. `Screen.Settings` reached from the gallery gear icon.
- Streaming download added: `NekoBooruApi.download(@Url)` returns `ResponseBody`.

**Verify:** airplane-mode test below; confirm a periodic sync fires on reconnect and a
shared image lands in Add.

---

## Known caveats / TODO

- **Video playback**: in-app via Media3/ExoPlayer (`ui/VideoPlayer.kt`), autoplay+loop
  like the website. Plays the cached original when the offline mirror has it, else
  streams. On-view does *not* force-download video originals (the offline policy mirrors
  them in the background instead).
- **Notes/comments**: deferred. The change feed delivers them and the backend push
  accepts them; the client just ignores `note`/`comment` pulls and has no UI yet.
- **Pool ordering on phone**: "Add to pool" appends to the end; there's no drag-reorder
  UI (the CSV/`order` plumbing supports it if added later).
- **No auth** (LAN-only per decision). `usesCleartextTraffic=true`. Revisit if remote
  access is ever wanted (Tailscale/VPN + API key).
- **Push conflict**: client omits `updatedAt`, so phone edits always win on push. Fine
  for single user; revisit for true multi-device.
- **Soft-deleted originals** accumulate server-side (no purge/GC tool yet).
- **Line endings**: git warns LF→CRLF on commit; harmless. `gradlew` is committed.
- **gradle-wrapper.jar** is committed (intentional, so the project builds standalone).

---

## End-to-end runtime check (do this once)

1. Backend: `backend/start-dev.bat` (or `cd backend && python run.py`).
2. Android Studio → open `android/` → Run on an emulator.
3. **Settings** (gear icon) → set Server URL `http://10.0.2.2:8000` → back → **Sync** →
   gallery matches the site.
4. **Airplane mode**: add+tag a new image (shows with upload badge), edit one post's
   tags, delete another. Re-enable Wi-Fi → **Sync** → confirm on the web UI: new upload
   present, tags changed, deleted post gone. Then a web-side edit → **Sync** on phone →
   change appears. (Physical phone: use the server's LAN IP instead of 10.0.2.2.)
5. **Pools**: list icon → create a pool; open a post → "Add to pool" → Sync → pool shows
   on the web. Create a pool on the web → Sync on phone → it appears with its members.
6. **Share target**: from the system Photos app, Share → NekoBooru → lands in Add
   pre-filled → Add & sync.
7. **Retention**: Settings → "Favorites & pools"; favorite a post, Sync, then airplane
   mode → open it → full image still loads from the cached original.
