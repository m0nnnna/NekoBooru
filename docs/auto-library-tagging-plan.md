# Auto Library Tagging Plan

## Scope

This plan applies only to NekoBooru. The Eternia backend at
`X:\Unreal Engine\Engine\EterniaBackend\eternia-backend` is reference material
for its image tagging design, but should not be modified for this feature.

The goal is to add auto-tagging for:

- new uploads and batch imports;
- existing lightly tagged library items;
- manual "run this on my library" workflows from the UI;
- tunable thresholds, limits, and merge behavior.

## Current Audit

NekoBooru currently has a compact library model:

- `posts` stores one row per media item.
- `tags` and `post_tags` store normalized tag names and associations.
- tag aliases and implications already exist and should be reused by any auto
  tagging workflow.
- imports already have an `auto_tags()` placeholder in `batch_import.py`.
- uploads create posts through one shared path in
  `backend/app/routers/posts.py`, which is the right place to merge model tags
  for new items.

The existing library gap is that there is no job model, queue, bulk operation,
or UI action to iterate over already stored media and add model tags later.

The Eternia backend reference has a more advanced hybrid tagger:

- WD-Tagger style visual tags and character tags.
- model outputs are treated as optional and failure-tolerant.
- tagging is done outside the request path for large backlogs.
- operational tuning is explicit through settings/env.

NekoBooru should copy those architectural ideas, not the whole backend.

## Deep Audit Findings

Backend surfaces:

- `backend/app/models/post.py` is the library authority. `Post.extension`,
  `Post.duration`, `Post.safety`, and `Post.tags` are enough to choose image vs
  video strategy and update the visible rating.
- `backend/app/routers/posts.py` already centralizes create/update behavior.
  `process_tags_for_post()` is the correct shared merge path because it applies
  aliases and implications and updates tag usage counts.
- `backend/app/services/media.py` already depends on ffmpeg/ffprobe for video
  thumbnails and duration. Auto-tagging should reuse this style instead of
  inventing a second media probing layer.
- `backend/app/services/sync.py` listens for `Post` updates and writes
  `sync_log` rows. Auto-tagging should update the `Post` ORM row normally so
  Android sync sees changed tags/safety without a separate sync integration.
- `backend/app/services/settings.py` stores JSON settings. This is the lowest
  friction place for live auto-tag defaults, while job history belongs in
  SQLite.
- `backend/app/database.py` already has an idempotent `_migrate()` function for
  lightweight SQLite changes. New auto-tag job/result tables can be added
  there without a full migration framework.

Frontend surfaces:

- `frontend/src/views/SettingsView.vue` is the best home for library-wide
  controls because it already shows library stats, videos count, and operational
  settings.
- `frontend/src/views/PostView.vue` is the right per-post entry point. The
  button should sit near `Edit Tags` and `Rating`, because users will review
  suggestions and safety changes together.
- `frontend/src/views/UploadView.vue` already keeps per-upload tags and safety
  in each queue item. Import-time auto-tagging should be a queue-level toggle
  plus an optional per-item preview later.
- `frontend/src/api/client.js` needs a small endpoint group; no store is
  required unless job progress becomes shared across pages.

Android surfaces:

- Android consumes post tags/safety through sync DTOs. If backend updates posts
  through ORM flush/commit, sync should propagate auto-tag changes naturally.
- Android does not need auto-tag controls in the first implementation. It only
  needs to tolerate new tags/safety values it already supports.

Existing risks:

- Long model inference must not run inside normal request handlers for bulk
  jobs. The UI can trigger a job, but the processing loop should run in a
  background task/thread with cancellation checks.
- SQLite has one writer at a time. The job should process and commit one post at
  a time or in very small batches to keep the UI responsive.
- Tag usage counts can drift if tags are manually rewritten outside
  `process_tags_for_post()`. Every implementation path must reuse that helper
  or a refactored shared service equivalent.
- Video safety cannot rely on only one frame. A single sampled frame can miss
  explicit content. Safety should use "max risk across sampled frames".
- Political/semantic tags can be noisy. They should start in preview/review
  mode and only use conservative labels unless OCR/transcript evidence exists.

## Implementation Blueprint

### Backend Modules

Add these NekoBooru-only modules:

- `backend/app/models/auto_tag.py`
  - `AutoTagJob`
  - `AutoTagSuggestion`
- `backend/app/services/auto_tagger.py`
  - optional WD-Tagger model loading;
  - image tagging;
  - video frame extraction + frame merge;
  - safety classification;
  - model health/capability reporting.
- `backend/app/services/auto_tag_jobs.py`
  - creates jobs;
  - selects candidate posts;
  - runs/cancels jobs;
  - applies suggestions through the canonical tag merge path.
- `backend/app/routers/auto_tags.py`
  - exposes settings, per-post tagging, job creation/progress, cancellation,
    and preview endpoints.

Refactor target:

- Move `process_tags_for_post()` from `backend/app/routers/posts.py` into a
  reusable service, for example `backend/app/services/tags.py`.
- Keep the router importing that helper so existing create/update behavior stays
  the same.
- Add an `apply_tags_to_post(db, post, tags, merge_mode)` helper that updates
  tag links, usage counts, and `post.updated_at` consistently.

### SQLite Schema

Add tables through `backend/app/database.py::_migrate()` and SQLAlchemy models.

`auto_tag_jobs`:

- `id INTEGER PRIMARY KEY`
- `status TEXT NOT NULL`
- `mode TEXT NOT NULL`
- `total INTEGER DEFAULT 0`
- `processed INTEGER DEFAULT 0`
- `tagged INTEGER DEFAULT 0`
- `skipped INTEGER DEFAULT 0`
- `failed INTEGER DEFAULT 0`
- `cancel_requested INTEGER DEFAULT 0`
- `settings_snapshot TEXT NOT NULL`
- `created_at DATETIME`
- `started_at DATETIME`
- `finished_at DATETIME`
- `error TEXT`

`auto_tag_suggestions`:

- `id INTEGER PRIMARY KEY`
- `job_id INTEGER NULL`
- `post_id INTEGER NOT NULL`
- `status TEXT NOT NULL`
- `suggested_tags TEXT NOT NULL`
- `suggested_safety TEXT`
- `evidence TEXT NOT NULL`
- `model TEXT`
- `error TEXT`
- `created_at DATETIME`
- `applied_at DATETIME`

Indexes:

- `ix_auto_tag_jobs_status_created_at`
- `ix_auto_tag_suggestions_job_post`
- `ix_auto_tag_suggestions_post_status`

Rationale:

- Suggestions make preview/dry-run explainable.
- A nullable `job_id` lets per-post preview create a suggestion without a bulk
  job.
- JSON is stored as text to match the existing lightweight SQLite style.

### Settings Contract

Expose settings under `GET/PUT /api/auto-tags/settings`.

Shape:

```json
{
  "enabled": false,
  "tagNewUploads": false,
  "tagNewImports": false,
  "tagImages": true,
  "tagVideos": true,
  "generalThreshold": 0.35,
  "characterThreshold": 0.45,
  "maxTags": 40,
  "addProvenanceTag": true,
  "provenanceTag": "auto_tagged",
  "applySafety": true,
  "unsafeThreshold": 0.70,
  "sketchyThreshold": 0.45,
  "neverDowngradeSafety": true,
  "defaultBackfillMode": "lightly_tagged",
  "lightlyTaggedMaxTags": 2,
  "mergeMode": "append_new",
  "previewByDefault": true,
  "videoFrameStrategy": "multi",
  "videoMaxFrames": 4,
  "videoMaxDurationSeconds": 900,
  "semanticPoliticalEnabled": false,
  "ocrEnabled": false,
  "whisperEnabled": false,
  "qwenEnabled": false,
  "excludedTags": [],
  "keywordRules": []
}
```

Validation:

- thresholds must be between `0.0` and `1.0`;
- `maxTags` should be between `1` and `200`;
- `videoMaxFrames` should be between `1` and `8`;
- merge mode is one of `append_new`, `replace_auto_tags`, `preview_only`;
- safety values remain `safe`, `sketchy`, `unsafe`.

### API Contract

Status and capability:

- `GET /api/auto-tags/status`
  - returns whether optional dependencies are present, model loaded state,
    ffmpeg availability, and supported media types.

Per-post:

- `POST /api/posts/{post_id}/auto-tags/preview`
  - returns suggested tags/safety/evidence without applying.
- `POST /api/posts/{post_id}/auto-tags/apply`
  - applies suggestions immediately, or accepts edited suggestions from the UI.

Bulk:

- `POST /api/auto-tags/jobs`
  - body: mode, optional post IDs, dry-run flag, settings overrides.
- `GET /api/auto-tags/jobs/current`
  - returns active queued/running job if one exists.
- `GET /api/auto-tags/jobs/{job_id}`
  - returns progress and summary.
- `GET /api/auto-tags/jobs/{job_id}/suggestions`
  - paginated suggestions/errors for review.
- `POST /api/auto-tags/jobs/{job_id}/cancel`
  - sets `cancel_requested`.
- `POST /api/auto-tags/jobs/{job_id}/apply`
  - applies accepted dry-run suggestions in batches.

Candidate counts:

- `GET /api/auto-tags/estimate?mode=lightly_tagged`
  - returns count split by images, gifs, videos, skipped unsupported.

### Job Selection Modes

`untagged`:

- posts with zero tags.

`lightly_tagged`:

- posts where tag count is `<= lightlyTaggedMaxTags`.

`all`:

- all non-deleted posts.

`selected`:

- explicit IDs from the request.

`videos`:

- video extensions only.

`images`:

- image/gif extensions only.

### Processing Algorithm

For each candidate:

1. Resolve the content path from `Post.content_path`.
2. Skip missing files and record a failed suggestion row.
3. Choose image or video pipeline from extension.
4. Run model inference with the job settings snapshot.
5. Merge:
   - manual tags stay first;
   - model tags are normalized;
   - excluded tags are removed;
   - provenance tag is added when enabled;
   - aliases/implications are applied by the shared tag service.
6. Safety:
   - `unsafe` wins over all other values;
   - `sketchy` can promote `safe`;
   - never downgrade when `neverDowngradeSafety` is true.
7. If dry-run, write suggestion only.
8. If apply mode, update post tags/safety, touch `updated_at`, and commit.
9. Update job counters after each post.
10. Check cancellation before the next post.

### Video Pipeline

Frame extraction:

- use `ffprobe` duration from existing `Post.duration` when available;
- fallback to `get_video_info()` if missing;
- extract frames to temporary files under `settings.cache_dir / "auto-tags"`;
- clean frames after each post.

Frame timestamps:

- duration `< 8s`: `[0.5 * duration]`;
- duration `8s..60s`: `[0.25, 0.5, 0.75] * duration`;
- duration `> 60s`: `[0.10, 0.35, 0.60, 0.85] * duration`;
- cap at `videoMaxFrames`.

Frame filtering:

- skip failed frames;
- optionally skip near-black frames by average luminance;
- optionally skip duplicate frames by perceptual hash later.

Merge:

- keep tags seen in two or more frames;
- keep any single-frame tag above a high-confidence threshold;
- safety uses maximum rating across all frames;
- evidence should include frame timestamps and top tags per frame.

### Political And Edit Semantics

This is optional and should not block the first video implementation.

Pipeline:

1. WD-Tagger frame tags.
2. OCR sampled frames using PP-OCRv5.
3. Transcribe audio using faster-whisper / Whisper large-v3.
4. Send sampled frame summaries, OCR text, transcript excerpt, filename, and
   folder hints to Qwen2.5-VL-7B-Instruct for conservative labels.

Rules:

- `political_edit` should require filename/folder keyword, OCR keyword, or
  transcript evidence.
- public figure or ideology tags should require explicit text/audio evidence or
  a user-defined keyword rule.
- semantic suggestions start as preview-only.

### UI Implementation

Settings page:

- Add an `Auto Tagging` section after Server Statistics.
- Show model status:
  - disabled;
  - missing dependencies;
  - ready;
  - ffmpeg missing;
  - running job.
- Add controls for thresholds, max tags, safety, video frames, and merge mode.
- Add an estimate button.
- Add start buttons:
  - `Preview lightly tagged library`;
  - `Auto-tag lightly tagged library`;
  - `Auto-tag videos`;
  - `Cancel`.
- Poll current job every 1-2 seconds while running.

Post page:

- Add `AI Tag` button near `Edit Tags`.
- Preview modal:
  - suggested tags;
  - suggested safety;
  - evidence summary;
  - accept/apply button;
  - editable tag list before apply.

Upload page:

- Add `Auto-tag new uploads` queue toggle.
- Send `autoTag: true/false` on create.
- Later: add per-upload preview after upload token creation.

### Tests

Backend unit tests:

- tag normalization dedupes model/user tags;
- excluded tags are removed;
- aliases and implications apply to auto tags;
- safety only promotes, never downgrades;
- unsafe frame in a video promotes post to `unsafe`;
- missing optional dependencies return disabled/missing status;
- missing media file records failure and continues job;
- cancellation stops between posts.

Backend integration tests:

- per-post preview does not alter DB;
- per-post apply changes tags/safety and sync log records post update;
- bulk dry-run creates suggestions without changing posts;
- bulk apply changes expected posts only;
- duplicate job start is rejected while one is running.

Frontend checks:

- settings controls validate bounds;
- progress state renders queued/running/completed/failed/cancelled;
- post preview modal handles empty suggestions and errors.

Manual QA:

- small image library;
- mixed image/video library;
- missing ffmpeg;
- tagger disabled;
- tagger dependencies absent;
- explicit/sensitive test samples confirm unsafe promotion.

## Stage 1 - Optional Local Tagger Foundation

Status: partially scaffolded in NekoBooru.

Build a dependency-optional local image tagger service:

- keep the base app light;
- install ML dependencies separately through `backend/requirements-tagger.txt`;
- enable with `NEKO_AUTO_TAGGER_ENABLED=true`;
- run WD-Tagger lazily and return empty results when disabled or unavailable;
- normalize tags the same way the rest of NekoBooru does;
- merge user tags first, then auto tags, preserving manual intent.

Acceptance:

- app starts without tagger dependencies installed;
- auto-tag requests return a clear disabled/missing-dependency result;
- new post creation can opt in to auto-tagging without changing existing upload
  behavior when disabled.

## Stage 2 - Existing Library Backfill API

Add backend-only job support for the existing library.

Proposed data:

- `auto_tag_jobs`
  - `id`
  - `status`: queued, running, completed, failed, cancelled
  - `mode`: all, missing_tags, selected_posts
  - `total`
  - `processed`
  - `tagged`
  - `skipped`
  - `failed`
  - `settings_snapshot`
  - `created_at`, `started_at`, `finished_at`
  - `error`

Proposed endpoints:

- `POST /api/auto-tags/jobs`
  - starts a library tagging job;
  - body includes mode and tuning options.
- `GET /api/auto-tags/jobs/{id}`
  - returns progress.
- `POST /api/auto-tags/jobs/{id}/cancel`
  - requests cancellation.
- `POST /api/posts/{id}/auto-tags`
  - tags one item immediately, useful from the post detail page.

Job behavior:

- default mode should be `missing_tags`, meaning posts with zero tags or only
  very light tags.
- selected mode should accept explicit post IDs.
- avoid deleting existing manual tags.
- apply aliases and implications through the existing tag pipeline.
- skip non-image files at first; videos can be a later stage using extracted
  frames.

Acceptance:

- a job can process the current library without blocking the FastAPI request;
- progress is visible through the API;
- cancelled jobs stop cleanly between items;
- failed images do not stop the whole job.

## Stage 3 - Tuning Settings

Add persistent settings for auto-tag behavior.

Recommended controls:

- enable/disable auto-tagging globally;
- general tag threshold;
- character tag threshold;
- maximum tags per image;
- add provenance tag, e.g. `auto_tagged`;
- safety auto-classification on/off;
- safety thresholds;
- backfill mode:
  - add only when a post has no tags;
  - add only when tag count is below N;
  - add to all posts;
- merge mode:
  - append auto tags;
  - append only if tag is new;
  - preview only;
- excluded tags list;
- minimum confidence per tag family.

Storage options:

- use the existing JSON settings file for app-level preferences; or
- add a small SQLite table if job snapshots need relational history.

Recommendation:

- store the live defaults in the settings file;
- snapshot settings into each job row so old jobs remain explainable.

Acceptance:

- changing thresholds affects the next run, not jobs already started;
- users can reset to defaults;
- bad values are validated before a job starts.

## Stage 4 - UI Button And Workflow

Add a Library Auto-Tag panel in Settings or Tags.

Primary controls:

- `Auto-tag untagged/lightly tagged library`
- `Preview on selected image`
- `Cancel current job`
- threshold sliders or number inputs;
- max tag count input;
- safety classification toggle;
- merge mode selector.

Progress display:

- total items;
- processed count;
- tagged count;
- skipped count;
- failed count;
- current status;
- last error if any.

Post detail:

- add a small `Auto-tag` action near the tag editor;
- show suggested tags before applying if preview mode is enabled.

Acceptance:

- user can start a backfill from the UI;
- progress updates without refreshing;
- tuning controls are saved and reused;
- manual tags remain visible and are not removed.

## Stage 5 - Preview And Review

Add review-first workflows for safer tuning.

Features:

- dry-run job mode that records suggestions without applying them;
- per-post suggested tag preview;
- accept all suggested tags for a post;
- reject selected suggestions;
- apply same threshold to preview and real run.

Acceptance:

- user can tune thresholds on a sample image before running the full library;
- dry-run results make it obvious whether thresholds are too noisy;
- accepted tags go through aliases and implications.

## Stage 6 - Video Support

Extend auto-tagging to videos as a priority after the image path is stable.
Most of the existing library is video-heavy, so the library backfill UI should
surface video coverage clearly instead of treating it as an edge case.

Approach:

- extract multiple frames from videos with ffmpeg;
- run the image tagger over those frames;
- merge frame results by confidence;
- cap video duration and bytes to avoid slow scans.

Recommended frame strategy:

- short clips under 8 seconds: sample the middle frame;
- normal clips: sample 25%, 50%, and 75%;
- longer edits/AMVs: sample 10%, 35%, 60%, and 85%;
- optionally skip black/near-duplicate frames so fade-ins and transition frames
  do not dominate the result.

Middle frame alone is a good first smoke test because it is cheap and often
captures the main subject. It is not enough for AMVs or political edits because
the middle can land on a transition, title card, reaction image, or unrelated
cutaway. A small multi-frame sample is usually a better default for the same
model because it catches recurring subjects and explicit frames without needing
a full video model.

Tag merge behavior:

- collect tags per sampled frame;
- keep tags that appear across multiple frames or exceed a higher confidence
  threshold on one frame;
- keep character tags if they appear in any strong frame;
- add `video`, and optionally `auto_tagged`;
- add `amv`, `edit`, or `political_edit` from filename/folder/rule hints rather
  than expecting WD-Tagger to infer those concepts.

Safety behavior:

- if any sampled frame is explicit/questionable above the configured unsafe
  threshold, set NekoBooru `safety` to `unsafe`;
- if sampled frames are borderline sensitive, set `safety` to `sketchy`;
- never downgrade an existing `unsafe` post to `sketchy` or `safe`;
- make safety auto-classification tunable, but default it on for backfill.

Acceptance:

- short videos produce useful tags;
- long/large videos are skipped or sampled safely;
- missing ffmpeg degrades without crashing the app.
- unsafe model ratings update the post's NekoBooru safety field to `unsafe`.

## Stage 7 - Operational Hardening

Add guardrails before making this a default feature.

Work:

- structured logs for job start/finish/fail;
- model load errors surfaced in the UI;
- max concurrent job count of one;
- job cancellation checks between posts;
- tests for tag merging, aliases, implications, and job cancellation;
- README section for optional dependency install and env settings.

Acceptance:

- users can recover from a bad threshold run by editing tags normally;
- no startup crash when optional dependencies are absent;
- no request timeout during full-library tagging;
- backfill can resume after app restart.

## Stage 8 - Political Edit And AMV Semantics

Add a separate optional semantic pass for videos where booru frame tags are not
enough. This is especially useful for AMVs, edits, news clips, speeches, and
political edits.

Recommended model pipeline:

- WD-Tagger v3 remains the default visual tagger for sampled frames.
- PaddleOCR / PP-OCRv5 extracts on-screen captions, names, subtitles, slogans,
  watermarks, and news chyron text.
- Whisper large-v3, preferably through faster-whisper for local speed, extracts
  speech, chants, narration, and lyrics from audio.
- The semantic classifier is selectable in Settings. Keep the existing
  Qwen2.5-VL-7B-Instruct Transformers backend as the stable fallback, and add
  Qwen3-VL-8B GGUF variants for faster local llama.cpp inference:
  - `Qwen3VL-8B-Instruct-Q4_K_M.gguf` for the fast/low-memory path.
  - `Qwen3VL-8B-Instruct-Q8_0.gguf` for the higher-quality local path.
  - `mmproj-Qwen3VL-8B-Instruct-F16.gguf` as the shared vision projector.
  Use the selected semantic backend on sampled frames plus OCR/transcript
  excerpts rather than asking it to process every frame.

Why this split:

- WD-Tagger is good at booru-style visual tags but does not reliably understand
  politics, slogans, named public figures, or edit intent.
- OCR catches a large amount of political context because edits often put the
  important meaning directly on screen.
- Whisper catches spoken context that no frame tagger can see.
- Qwen semantic models can produce broader tags like `political_edit`, `rally`,
  `speech`, `news_clip`, `military_edit`, `election`, or `propaganda_style`,
  but should be treated as optional and reviewable because semantic labels can
  be noisy.

Default conservative tags:

- `amv`
- `edit`
- `political_edit`
- `news_clip`
- `speech`
- `rally`
- `subtitles`
- `watermark`
- `military`
- `election`

Rules:

- prefer filename, folder, OCR, and transcript evidence before applying
  political tags;
- keep semantic political tags in preview/review mode at first;
- do not infer extreme or sensitive ideology labels without explicit text/audio
  evidence or user-defined rules;
- let users define custom keyword-to-tag mappings, e.g. folder or OCR text
  containing a phrase adds a chosen tag.

Acceptance:

- AMVs and edits can be tagged as edits even when WD-Tagger only sees anime
  frames;
- political videos get conservative context tags from text/audio evidence;
- Qwen2.5-VL output is explainable by showing the OCR/transcript/frame evidence
  used for the suggestion;
- semantic tags can be reviewed before applying to the whole library.

## Stage 9 - Anime Character And Source Identification

Add a dedicated character/copyright recognition layer for anime and game
characters. This should be separate from the general visual tagger because
character naming is a fixed-vocabulary, high-confidence task, while visual
tagging is broader and noisier.

Recommended model stack:

- WD-Tagger v3 remains the baseline visual tagger and can provide character
  tags when it is confident.
- Camais03/camie-tagger-v2, or the current Camie Tagger release, should be the
  preferred character/copyright layer once integrated.
- Qwen2.5-VL can be used only as a fallback/explanation layer for famous
  characters, not as the source of truth, because it may hallucinate names.

Target outputs:

- `character` tags for named characters;
- `copyright` tags for anime/game/franchise/source;
- optional `artist` tags only if a model explicitly supports them later;
- evidence containing model confidence, frame timestamp for videos, and whether
  the same character appeared across multiple sampled frames.

Video behavior:

- run character recognition on the same sampled frames as the video visual
  tagger;
- keep a character tag if it appears in multiple frames or exceeds a high
  single-frame confidence threshold;
- for AMVs, allow multiple character tags when different frames clearly contain
  different characters;
- for edits with fast cuts, prefer preview mode so the user can reject
  accidental character matches.

Category behavior:

- auto-created character names should use the existing `character` tag category;
- auto-created franchise/source names should use the existing `copyright`
  category;
- aliases should still resolve before category assignment, so local preferred
  names win.

Safety and review:

- character/source suggestions should never affect `safety`;
- low-confidence character guesses should stay in preview only;
- user-defined blocklists should be supported for characters/franchises that
  the model commonly confuses.

Acceptance:

- a single image can receive both visual tags and character/source tags;
- a video can collect character/source tags from sampled frames;
- character tags are not mixed into the general category;
- low-confidence or conflicting character matches are reviewable before bulk
  apply.

## Default Behavior Recommendation

## Stage 10 - Persisted Semantic Analysis And Search

Persist Qwen semantic evidence separately from normal tags so it can power
phrase search without polluting the library with every descriptive sentence.
Use a dedicated `post_ai_analysis` table keyed by post/model/profile, with
parsed semantic tags, safety, rationale, summary, raw model output, prompt hash,
timings, and a normalized `search_text` field. Mirror the search text into an
FTS5 table when SQLite supports it, and fall back to regular text matching
when it does not.

Save semantic analysis only from Qwen-family outputs and only when enabled by
the app/import/bulk setting or the browser-extension upload checkbox. Do not
store WD/Camie/Whisper/OCR evidence in this table unless a later feature needs
that; their compact evidence already lives in preview/job records.

Semantic search should never run a model at query time. A plain query expands
each word against both known tag names and saved Qwen analysis text, then ANDs
the word groups together. This lets searches like `red banner`, `music edit`,
or `political protest` find posts whose saved Qwen rationale mentions those
ideas even if the final applied tags were kept conservative.

Acceptance:

- per-post apply, import auto-tagging, bulk run/apply-preview, and extension
  uploads can save Qwen analysis when the setting is enabled;
- post view can display saved analysis for inspection;
- extension settings can default the save-analysis checkbox;
- semantic search matches saved rationale/summary/raw output as well as tags;
- saved analysis is not stored as comments and does not create user-visible tag
  clutter.

## Default Behavior Recommendation

Keep auto-tagging disabled by default until the UI exists. Once the button,
progress, and tuning controls are in place:

- enable manual one-click backfill;
- keep automatic tagging for new imports opt-in;
- default backfill mode to posts with zero tags or fewer than two tags;
- never remove manual tags automatically.
