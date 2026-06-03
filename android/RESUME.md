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
| **B6** | Sync pools / notes / comments | ⏳ TODO (this doc) |
| **B7** | WorkManager auto-sync + share target + retention | ⏳ TODO (this doc) |

The core loop (browse, add, edit, delete, favorite, two-way sync) is functionally
complete. Each step was verified to compile via `assembleDebug` but **not yet run on
an emulator** — runtime verification is the recommended next manual check (see end).

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
- `data/SyncDtos.kt` — `SyncChangesResponse`, `SyncChange`, `PushChangeDto`, `PushResponseDto`, `UploadTokenDto`.
- `data/NekoBooruApi.kt` — Retrofit interface + `ApiFactory` (Json is public; `absoluteUrl()` resolves relative media URLs).
- `data/AppSettings.kt` — SharedPreferences; `serverUrl` default `http://10.0.2.2:8000` (emulator→host).
- `data/db/Entities.kt` — `PostEntity` (PK sha256; local fields `dirty`, `deleted`, `localMediaPath`), `SyncStateEntity` (cursor), `PendingChangeEntity` (outbox).
- `data/db/Daos.kt` — `PostDao`, `SyncStateDao`, `OutboxDao`.
- `data/db/NekoDatabase.kt` — Room DB (**version 2**, `fallbackToDestructiveMigration`).
- `data/SyncRepository.kt` — `pull()`, `push()`, `enqueueNewPost/Edit/Delete/Favorite()`.
- `ui/` — `GalleryScreen`+VM, `AddScreen`+VM, `DetailScreen`+VM, `Theme.kt`.
- `MainActivity.kt` — sealed `Screen { Gallery, Add, Detail(sha) }` state-based nav.

**Key conventions / decisions:**
- New offline posts get a **placeholder** `PostEntity` keyed `pending-<clientId>` with
  `dirty=true` + `localMediaPath` so they show immediately; on successful push the
  placeholder is deleted and the canonical post (with thumbnail) arrives via `pull()`.
- `push()` then `pull()` on every "Sync"; cursor is NOT advanced to the push response
  (so our own post comes back once, bringing its server thumbnail).
- Pending posts disable edit/delete in detail until synced.
- Bumping the Room schema = bump `version` in `NekoDatabase` (destructive migration is on).

---

## Step 6 — sync pools, notes, comments

The change feed already delivers these; `SyncRepository.applyChanges()` currently
ignores non-post/favorite types. Pools are the worthwhile one on a phone; notes/comments
are niche — consider pools-only first.

**Data (Room, bump DB to v3):**
- `PoolEntity(uuid PK, serverId?, name, description?, createdAt?, updatedAt?, postSha256sCsv, dirty, deleted)`.
  Store members as a CSV of post sha256 (ordered) — mirrors `data.postSha256s`.
- (Optional) `NoteEntity(uuid PK, postSha256, x,y,width,height,text, dirty, deleted)`,
  `CommentEntity(uuid PK, postSha256, text, createdAt, dirty, deleted)`.
- Add DAOs (`PoolDao` etc.); register entities in `NekoDatabase`, version=3.

**Pull** (`SyncRepository.applyChanges`): add branches:
- `"pool"` → upsert/delete `PoolEntity` (decode `data` to a `PoolSyncDto{uuid,name,description,postSha256s}`; join sha list to CSV).
- `"note"`/`"comment"` → upsert/delete by uuid (decode includes `postSha256`).

**Push** (`SyncRepository.push`): handle queued pool/note/comment changes:
- Pool upsert → `PushChangeDto(type="pool", uuid, name, description, postSha256s=...)`.
- Pool delete → `(type="pool", op="delete", uuid)`. Note/comment analogous.
  NOTE: `PushChangeDto` must gain fields `uuid, name, description, postSha256s, postSha256, text, x, y, width, height` (backend already accepts them — see `PushChange` in `backend/app/routers/sync.py`).

**UI (minimal):**
- A Pools list screen (LazyColumn of `PoolEntity`, tap → pool view = grid filtered to its `postSha256s`).
- "Add to pool" from `DetailScreen` (pick/create a pool → update CSV locally + queue pool upsert).
- Add `Screen.Pools` / `Screen.Pool(uuid)` to `MainActivity` nav; a simple tab or menu entry.
- Notes/comments UI optional; can defer or show read-only on detail.

**Verify:** `assembleDebug`; then create a pool on the web UI → Sync on phone → pool
appears; create/modify a pool on phone offline → Sync → shows on web.

---

## Step 7 — auto-sync + share target + retention

**WorkManager auto-sync:**
- Add deps: `androidx.work:work-runtime-ktx:2.9.1`.
- `SyncWorker(CoroutineWorker)` → `repo.push(url); repo.pull(url)` (read URL from `AppSettings`); return `Result.retry()` on `IOException`, else `success`.
- Schedule a `PeriodicWorkRequest` (e.g. 1–6h) with `NetworkType.CONNECTED` constraint,
  + a one-shot enqueue on app start and after each local change (`enqueueUniqueWork`).
  This replaces the manual "Sync" button as the primary trigger (keep the button too).
- Surface last-synced time / online state in the gallery top bar (mirrors web
  `frontend/src/components/BackendStatus.vue`).

**Android share target ("Share to NekoBooru"):**
- In `AndroidManifest.xml`, add an `<intent-filter>` to `MainActivity` (or a dedicated
  activity) for `ACTION_SEND` with `mimeType` `image/*` and `video/*`.
- On launch with a shared `EXTRA_STREAM` Uri, route straight into the Add flow
  pre-populated with that Uri (reuse `AddViewModel.onPicked(uri)` + `copyToStorage`).
  Handle the read permission grant from the share intent.

**Retention settings:**
- `AppSettings`: add `retention` ∈ {EVERYTHING, FAVORITES_POOLS, ON_DEMAND}.
- After `pull()`, a maintenance pass downloads/evicts **original** files per policy
  (thumbnails always cached via Coil). New field on `PostEntity` like
  `localOriginalPath`; an LRU/eviction by access time for ON_DEMAND.
- A Settings screen (server URL — move it off the gallery — + retention radio + manual
  "Sync now" + status). Add `Screen.Settings` to nav.

**Verify:** airplane-mode test below; confirm a periodic sync fires on reconnect and a
shared image lands in Add.

---

## Known caveats / TODO

- **Video playback**: detail screen shows the video *thumbnail* + play badge only.
  In-app playback (Media3/ExoPlayer) is unscheduled — add when desired.
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
3. Set Server URL `http://10.0.2.2:8000` → **Sync** → gallery matches the site.
4. **Airplane mode**: add+tag a new image (shows with upload badge), edit one post's
   tags, delete another. Re-enable Wi-Fi → **Sync** → confirm on the web UI: new upload
   present, tags changed, deleted post gone. Then a web-side edit → **Sync** on phone →
   change appears. (Physical phone: use the server's LAN IP instead of 10.0.2.2.)
