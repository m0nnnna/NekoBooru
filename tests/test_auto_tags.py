import os
import sys
import tempfile
import time
import unittest
import asyncio
import types
from pathlib import Path
from unittest.mock import Mock, patch


class AutoTagApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["NEKO_BASE_DIR"] = cls.tmp.name
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

        from fastapi.testclient import TestClient
        from app.main import app

        cls.client = TestClient(app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        from app.database import engine

        asyncio.run(engine.dispose())
        os.environ.pop("NEKO_BASE_DIR", None)
        cls.tmp.cleanup()

    def _upload_image_post(self, tags=None, safety="safe"):
        token = self._upload_image_token()
        created = self.client.post(
            "/api/posts",
            json={
                "contentToken": token,
                "tags": tags or [],
                "safety": safety,
                "autoTag": False,
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        return created.json()

    def _upload_image_token(self):
        from PIL import Image

        stamp = time.time_ns()
        image_path = Path(self.tmp.name) / f"sample-{stamp}.png"
        color = (stamp % 255, (stamp // 255) % 255, (stamp // 65025) % 255)
        Image.new("RGB", (32, 32), color).save(image_path)
        with image_path.open("rb") as fh:
            upload = self.client.post(
                "/api/uploads",
                files={"content": (image_path.name, fh, "image/png")},
            )
        self.assertEqual(upload.status_code, 200, upload.text)
        return upload.json()["token"]

    def _upload_specific_image_token(self, image_path):
        with image_path.open("rb") as fh:
            upload = self.client.post(
                "/api/uploads",
                files={"content": (image_path.name, fh, "image/png")},
            )
        self.assertEqual(upload.status_code, 200, upload.text)
        return upload.json()["token"]

    def _enable_auto_tags(self):
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["enabled"] = True
        settings["applySafety"] = True
        settings["addProvenanceTag"] = True
        response = self.client.put("/api/auto-tags/settings", json={"settings": settings})
        self.assertEqual(response.status_code, 200, response.text)

    def _disable_auto_tags(self):
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["enabled"] = False
        response = self.client.put("/api/auto-tags/settings", json={"settings": settings})
        self.assertEqual(response.status_code, 200, response.text)

    def _fake_result(self):
        from app.services.auto_tagger import AutoTagResult

        return AutoTagResult(
            tags=["red eyes", "close-up"],
            character_tags=["hatsune_miku"],
            rating={"explicit": 0.91, "questionable": 0.2},
            safety="unsafe",
            categories={
                "red_eyes": "general",
                "close-up": "general",
                "hatsune_miku": "character",
            },
            evidence={"kind": "image", "test": True},
            model="fake-wd",
            enabled=True,
        )

    def test_disabled_preview_preserves_tags_without_provenance(self):
        self._disable_auto_tags()
        post = self._upload_image_post(tags=["manual_tag"])

        preview = self.client.post(f"/api/posts/{post['id']}/auto-tags/preview")

        self.assertEqual(preview.status_code, 200, preview.text)
        body = preview.json()
        self.assertEqual(body["suggestedTags"], ["manual_tag"])
        self.assertEqual(body["suggestedSafety"], "safe")
        self.assertEqual(body["error"], "disabled")
        self.assertNotIn("auto_tagged", body["categories"])

    def test_duplicate_post_response_includes_existing_post_link_data(self):
        from PIL import Image

        stamp = time.time_ns()
        image_path = Path(self.tmp.name) / f"duplicate-{stamp}.png"
        color = (stamp % 255, (stamp // 255) % 255, (stamp // 65025) % 255)
        Image.new("RGB", (32, 32), color).save(image_path)

        first_token = self._upload_specific_image_token(image_path)
        created = self.client.post(
            "/api/posts",
            json={"contentToken": first_token, "tags": [], "safety": "safe", "autoTag": False},
        )
        self.assertEqual(created.status_code, 200, created.text)
        post = created.json()

        second_token = self._upload_specific_image_token(image_path)
        duplicate = self.client.post(
            "/api/posts",
            json={"contentToken": second_token, "tags": [], "safety": "safe", "autoTag": False},
        )

        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        detail = duplicate.json()["detail"]
        self.assertEqual(detail["code"], "duplicate_post")
        self.assertEqual(detail["postId"], post["id"])
        self.assertEqual(detail["postUrl"], f"/post/{post['id']}")
        self.assertEqual(detail["post"]["id"], post["id"])

    def test_bulk_update_can_clear_tags_and_set_safety(self):
        first = self._upload_image_post(tags=["old_tag", "shared"], safety="safe")
        second = self._upload_image_post(tags=["another_tag", "shared"], safety="safe")

        response = self.client.post(
            "/api/posts/bulk-update",
            json={
                "postIds": [first["id"], second["id"]],
                "tagMode": "clear",
                "tags": [],
                "safety": "unsafe",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["updated"], 2)
        first_after = self.client.get(f"/api/posts/{first['id']}").json()
        second_after = self.client.get(f"/api/posts/{second['id']}").json()
        self.assertEqual(first_after["tags"], [])
        self.assertEqual(second_after["tags"], [])
        self.assertEqual(first_after["safety"], "unsafe")
        self.assertEqual(second_after["safety"], "unsafe")

    def test_per_post_apply_adds_tags_categories_and_promotes_unsafe(self):
        self._enable_auto_tags()
        post = self._upload_image_post(tags=["manual_tag"], safety="safe")

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._fake_result()):
            applied = self.client.post(f"/api/posts/{post['id']}/auto-tags/apply", json={})

        self.assertEqual(applied.status_code, 200, applied.text)
        body = applied.json()
        self.assertEqual(body["safety"], "unsafe")
        self.assertIn("manual_tag", body["tags"])
        self.assertIn("red_eyes", body["tags"])
        self.assertIn("hatsune_miku", body["tags"])
        self.assertIn("auto_tagged", body["tags"])

        tag = self.client.get("/api/tags/hatsune_miku")
        self.assertEqual(tag.status_code, 200, tag.text)
        self.assertEqual(tag.json()["category"], "character")

    def test_upload_token_preview_does_not_create_post(self):
        self._enable_auto_tags()
        token = self._upload_image_token()
        before_total = self.client.get("/api/posts").json()["total"]

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._fake_result()):
            preview = self.client.post(
                f"/api/uploads/{token}/auto-tags/preview",
                json={"tags": ["manual_tag"], "safety": "safe", "settings": {}},
            )

        self.assertEqual(preview.status_code, 200, preview.text)
        body = preview.json()
        self.assertIsNone(body["postId"])
        self.assertIn("manual_tag", body["suggestedTags"])
        self.assertIn("red_eyes", body["suggestedTags"])
        self.assertEqual(body["suggestedSafety"], "unsafe")
        self.assertEqual(self.client.get("/api/posts").json()["total"], before_total)

    def test_ytdlp_accepts_temporary_cookie_payload(self):
        import app.routers.uploads as uploads

        captured = {}
        real_import = __import__

        class FakeYoutubeDL:
            def __init__(self, opts):
                captured["cookiefile"] = opts.get("cookiefile")
                self.opts = opts

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def extract_info(self, url, download=False):
                return {"title": "locked video", "ext": "mp4"}

            def download(self, urls):
                Path(self.opts["outtmpl"].replace("%(ext)s", "mp4")).write_bytes(b"video")

        def fake_import(name, *args, **kwargs):
            if name == "yt_dlp":
                return types.SimpleNamespace(YoutubeDL=FakeYoutubeDL, version=types.SimpleNamespace(__version__="test"))
            return real_import(name, *args, **kwargs)

        cookies = "# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tsecret\n"
        with patch("builtins.__import__", side_effect=fake_import), patch("httpx.AsyncClient.head", side_effect=Exception):
            response = self.client.post(
                "/api/uploads/from-ytdlp",
                json={"url": "https://x.com/user/status/1", "cookies": cookies},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(captured["cookiefile"])
        self.assertFalse(Path(captured["cookiefile"]).exists())
        token = response.json()["token"]
        temp_path = uploads.get_upload_path(token)
        self.assertTrue(temp_path.exists())
        temp_path.unlink(missing_ok=True)
        uploads.remove_upload_token(token)

    def test_bulk_preview_job_can_apply_saved_suggestions(self):
        self._enable_auto_tags()
        post = self._upload_image_post(tags=[], safety="safe")

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._fake_result()):
            job_response = self.client.post(
                "/api/auto-tags/jobs",
                json={"mode": "selected", "dryRun": True, "postIds": [post["id"]], "settings": {}},
            )
            self.assertEqual(job_response.status_code, 200, job_response.text)
            job_id = job_response.json()["id"]
            for _ in range(20):
                job = self.client.get(f"/api/auto-tags/jobs/{job_id}").json()
                if job["status"] not in {"queued", "running"}:
                    break
                time.sleep(0.05)

        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["processed"], 1)
        self.assertEqual(job["tagged"], 1)

        unchanged = self.client.get(f"/api/posts/{post['id']}").json()
        self.assertEqual(unchanged["tags"], [])
        self.assertEqual(unchanged["safety"], "safe")

        apply_response = self.client.post(f"/api/auto-tags/jobs/{job_id}/apply")
        self.assertEqual(apply_response.status_code, 200, apply_response.text)
        self.assertEqual(apply_response.json()["applied"], 1)

        changed = self.client.get(f"/api/posts/{post['id']}").json()
        self.assertIn("red_eyes", changed["tags"])
        self.assertIn("hatsune_miku", changed["tags"])
        self.assertEqual(changed["safety"], "unsafe")

    def test_huggingface_token_lifecycle_does_not_echo_secret(self):
        with patch.dict(os.environ, {"HF_TOKEN": "", "HUGGINGFACE_HUB_TOKEN": ""}):
            response = self.client.delete("/api/auto-tags/huggingface-token")
            self.assertEqual(response.status_code, 200, response.text)

            response = self.client.put(
                "/api/auto-tags/huggingface-token",
                json={"token": "hf_test_secret"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["huggingFaceTokenConfigured"])
            self.assertNotIn("hf_test_secret", response.text)

            response = self.client.delete("/api/auto-tags/huggingface-token")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(response.json()["huggingFaceTokenConfigured"])

    def test_model_download_endpoint_reports_result(self):
        fake_result = {
            "model": "wd-eva02-large-tagger-v3",
            "modelId": "SmilingWolf/wd-eva02-large-tagger-v3",
            "downloaded": True,
            "loaded": False,
            "files": {
                "model.onnx": {"downloaded": True, "path": "model.onnx"},
                "selected_tags.csv": {"downloaded": True, "path": "selected_tags.csv"},
            },
            "huggingFaceTokenConfigured": False,
        }
        with patch("app.routers.auto_tags.download_model", return_value=fake_result):
            response = self.client.post("/api/auto-tags/model/download")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["downloaded"])
        self.assertEqual(response.json()["modelId"], "SmilingWolf/wd-eva02-large-tagger-v3")

    def test_model_catalog_lists_downloadable_models(self):
        response = self.client.get("/api/auto-tags/models")

        self.assertEqual(response.status_code, 200, response.text)
        ids = {model["id"] for model in response.json()["models"]}
        self.assertIn("wd", ids)
        self.assertIn("camie", ids)
        self.assertIn("qwen", ids)
        self.assertIn("ocr", ids)
        self.assertIn("whisper", ids)
        by_id = {model["id"]: model for model in response.json()["models"]}
        self.assertIn("downloadSize", by_id["qwen"])
        self.assertIn("vramRequirement", by_id["qwen"])
        self.assertIn("loaded", by_id["wd"])

    def test_model_download_routes_start_background_jobs(self):
        fake_job = {
            "id": "job-1",
            "status": "queued",
            "modelIds": ["wd"],
            "models": {},
        }

        with patch("app.routers.auto_tags.start_model_download", return_value=fake_job) as start:
            response = self.client.post("/api/auto-tags/models/wd/download")
        self.assertEqual(response.status_code, 200, response.text)
        start.assert_called_once_with(["wd"])

        with patch("app.routers.auto_tags.start_model_download", return_value=fake_job) as start:
            response = self.client.post("/api/auto-tags/models/download-all")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(start.call_count, 1)
        self.assertIn("wd", start.call_args.args[0])
        self.assertIn("camie", start.call_args.args[0])

    def test_model_download_cancel_route_cancels_active_job(self):
        fake_job = {
            "id": "job-1",
            "status": "cancelling",
            "modelIds": ["ocr"],
            "models": {
                "ocr": {
                    "id": "ocr",
                    "status": "cancelling",
                    "bytesDownloaded": 10,
                    "bytesTotal": 100,
                },
            },
        }

        with patch("app.routers.auto_tags.cancel_model_download", return_value=fake_job) as cancel:
            response = self.client.post("/api/auto-tags/models/download-job/cancel")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "cancelling")
        cancel.assert_called_once_with()

    def test_model_load_route_starts_prewarm_job(self):
        fake_job = {
            "id": "load-1",
            "status": "queued",
            "modelId": "wd",
            "progress": 0,
        }
        with patch("app.routers.auto_tags.start_model_load", return_value=fake_job) as start:
            response = self.client.post("/api/auto-tags/models/wd/load")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "load-1")
        start.assert_called_once_with("wd")

    def test_model_unload_route_unloads_model(self):
        fake_result = {
            "modelId": "wd",
            "model": "WD Tagger",
            "unloaded": True,
            "loaded": False,
            "models": [],
        }
        with patch("app.routers.auto_tags.unload_model", return_value=fake_result) as unload:
            response = self.client.post("/api/auto-tags/models/wd/unload")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["loaded"])
        unload.assert_called_once_with("wd")

    def test_delete_model_cache_removes_snapshot_models(self):
        from app.services import auto_tagger
        from app.services.auto_tagger import delete_model_cache, model_cache_status

        repo_cache = (
            Path(self.tmp.name)
            / "models"
            / "huggingface"
            / "hub"
            / "models--Camais03--camie-tagger-v2"
        )
        snapshot = repo_cache / "snapshots" / "abc123"
        snapshot.mkdir(parents=True, exist_ok=True)
        (snapshot / "camie-tagger-v2.onnx").write_bytes(b"fake")
        (snapshot / "camie-tagger-v2-metadata.json").write_text("{}", encoding="utf-8")
        (repo_cache / "blobs").mkdir(exist_ok=True)
        (repo_cache / "blobs" / "partial.incomplete").write_bytes(b"partial")

        with patch.object(auto_tagger.settings, "models_dir", Path(self.tmp.name) / "models"):
            self.assertTrue(model_cache_status("camie")["downloaded"])
            result = delete_model_cache("camie")
            camie_status = next(model for model in result["models"] if model["id"] == "camie")
            self.assertTrue(result["deleted"])
            self.assertFalse(camie_status["downloaded"])
            self.assertFalse(repo_cache.exists())


class AutoTagUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def test_video_timestamp_strategy_samples_middle_for_short_clip(self):
        from app.services.auto_tagger import AutoTagOptions, _timestamps

        self.assertEqual(_timestamps(6.0, AutoTagOptions(videoMaxFrames=4)), [3.0])

    def test_video_timestamp_strategy_samples_multiple_for_edits(self):
        from app.services.auto_tagger import AutoTagOptions, _timestamps

        self.assertEqual(
            _timestamps(100.0, AutoTagOptions(videoMaxFrames=4)),
            [10.0, 35.0, 60.0, 85.0],
        )

    def test_combine_results_merges_optional_model_tags(self):
        from app.services.auto_tagger import AutoTagResult, _combine_results

        result = _combine_results([
            AutoTagResult(tags=["1girl"], safety="safe", categories={"1girl": "general"}, model="wd", enabled=True),
            AutoTagResult(
                character_tags=["hatsune_miku"],
                copyright_tags=["vocaloid"],
                safety="unsafe",
                categories={"hatsune_miku": "character", "vocaloid": "copyright"},
                model="camie",
                enabled=True,
            ),
        ])

        self.assertIn("1girl", result.tags)
        self.assertIn("hatsune_miku", result.character_tags)
        self.assertIn("vocaloid", result.copyright_tags)
        self.assertEqual(result.safety, "unsafe")
        self.assertEqual(result.categories["hatsune_miku"], "character")

    def test_post_process_adds_media_type_tag(self):
        from app.services.auto_tagger import AutoTagOptions, AutoTagResult, _post_process

        image = _post_process(AutoTagResult(tags=["meme"]), Path("sample.jpg"), AutoTagOptions())
        video = _post_process(AutoTagResult(tags=["meme"]), Path("sample.mp4"), AutoTagOptions())
        gif = _post_process(AutoTagResult(tags=["meme"]), Path("sample.gif"), AutoTagOptions())

        self.assertIn("image", image.tags)
        self.assertIn("video", video.tags)
        self.assertIn("gif", gif.tags)
        self.assertEqual(video.categories["video"], "meta")

    def test_post_process_filters_default_noisy_tags(self):
        from app.services.auto_tagger import AutoTagOptions, AutoTagResult, _post_process

        result = _post_process(
            AutoTagResult(
                tags=["meme", "card_medium", "outline"],
                categories={"meme": "general", "card_medium": "general", "outline": "general"},
            ),
            Path("sample.png"),
            AutoTagOptions(),
        )

        self.assertIn("meme", result.tags)
        self.assertIn("image", result.tags)
        self.assertNotIn("card_medium", result.tags)
        self.assertNotIn("outline", result.tags)

    def test_safety_rating_requires_strong_evidence_for_promotion(self):
        from app.services.auto_tagger import AutoTagOptions, safety_from_rating

        opts = AutoTagOptions(unsafeThreshold=0.70, sketchyThreshold=0.45)

        self.assertEqual(safety_from_rating({"questionable": 0.50}, opts), "safe")
        self.assertEqual(safety_from_rating({"sensitive": 0.60}, opts), "safe")
        self.assertEqual(safety_from_rating({"explicit": 0.71}, opts), "unsafe")
        self.assertEqual(safety_from_rating({"questionable": 0.78}, opts), "sketchy")

    def test_meaningful_ocr_text_filters_blank_or_junk_text(self):
        from app.services.auto_tagger import _meaningful_ocr_text

        self.assertFalse(_meaningful_ocr_text(""))
        self.assertFalse(_meaningful_ocr_text(" . "))
        self.assertFalse(_meaningful_ocr_text("??"))
        self.assertFalse(_meaningful_ocr_text("TAX"))
        self.assertFalse(_meaningful_ocr_text("logo"))
        self.assertTrue(_meaningful_ocr_text("subtitle line"))
        self.assertTrue(_meaningful_ocr_text("hello world"))
        self.assertTrue(_meaningful_ocr_text("2026 election"))

    def test_whisper_song_transcript_adds_music_and_edit_tags(self):
        from app.services.auto_tagger import _whisper_tags_from_text

        tags = _whisper_tags_from_text("[Music] singing starts")

        self.assertIn("music", tags)
        self.assertIn("edit", tags)
        self.assertIn("has_speech", tags)

    def test_wd_can_be_disabled_for_per_run_overrides(self):
        from app.services.auto_tagger import AutoTagOptions, _tag_image

        with patch("app.services.auto_tagger._wd_tagger.tag_image") as wd_tag:
            result = _tag_image(Path("sample.png"), AutoTagOptions(wdEnabled=False))

        wd_tag.assert_not_called()
        self.assertEqual(result.error, "no_models_enabled")

    def test_missing_selected_model_returns_structured_error_without_loading(self):
        from app.services.auto_tagger import AutoTagOptions, _tag_image

        with patch("app.services.auto_tagger.runtime_available", return_value=True), \
             patch("app.services.auto_tagger.model_cache_status", return_value={"downloaded": False, "files": {}}), \
             patch("app.services.auto_tagger._camie_tagger.tag_image") as camie_tag:
            result = _tag_image(Path("sample.png"), AutoTagOptions(wdEnabled=False, characterModelEnabled=True))

        camie_tag.assert_not_called()
        self.assertEqual(result.error, "Camie Tagger v2: model_not_downloaded")
        self.assertEqual(result.evidence["models"][0]["evidence"]["action"], "download_model")

    def test_snapshot_model_status_uses_local_snapshot_without_snapshot_download(self):
        import tempfile
        from app.services import auto_tagger

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "huggingface" / "hub" / "models--openai--whisper-small" / "snapshots" / "abc"
            snapshot.mkdir(parents=True)
            (snapshot / "config.json").write_text("{}", encoding="utf-8")

            with patch.object(auto_tagger.settings, "models_dir", root), \
                 patch("app.services.auto_tagger.find_spec", return_value=True), \
                 patch("app.services.auto_tagger.huggingface_token", return_value=None), \
                 patch("huggingface_hub.hf_hub_download"):
                status = auto_tagger.model_cache_status("whisper")

        self.assertTrue(status["downloaded"])

    def test_qwen_load_job_uses_longer_estimate(self):
        from app.services.auto_tagger import _new_load_job

        job = _new_load_job("qwen", status="queued", progress=0, message="Queued")

        self.assertGreaterEqual(job["estimatedSeconds"], 90)

    def test_torch_device_setting_validates_to_auto(self):
        from app.services.auto_tagger import validate_options

        opts = validate_options({"torchDevice": "space_laser"})

        self.assertEqual(opts.torchDevice, "auto")

    def test_semantic_prompt_can_be_customized_and_validated(self):
        from app.services.auto_tagger import DEFAULT_SEMANTIC_PROMPT, validate_options

        custom = "Return tags about vaporwave_edit and city_pop."
        opts = validate_options({"semanticPrompt": custom})
        self.assertEqual(opts.semanticPrompt, custom)

        fallback = validate_options({"semanticPrompt": "  "})
        self.assertEqual(fallback.semanticPrompt, DEFAULT_SEMANTIC_PROMPT)

        capped = validate_options({"semanticPrompt": "x" * 5000})
        self.assertEqual(len(capped.semanticPrompt), 4000)

    def test_remote_infer_requires_token_when_bound_to_network(self):
        from fastapi import HTTPException
        from app.routers import auto_tags

        with patch("app.routers.auto_tags.tagger_worker_token", return_value=None):
            with patch.object(auto_tags.settings, "host", "127.0.0.1"):
                auto_tags._require_worker_token(None)

            with patch.object(auto_tags.settings, "host", "0.0.0.0"):
                with self.assertRaises(HTTPException) as ctx:
                    auto_tags._require_worker_token(None)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_search_tokenizer_keeps_unknown_colon_tags_literal(self):
        from app.services.search import TokenType, tokenize

        tokens = tokenize("beatrice_re:zero rating:safe")

        self.assertEqual(tokens[0].type, TokenType.TAG)
        self.assertEqual(tokens[0].value, "beatrice_re:zero")
        self.assertEqual(tokens[1].type, TokenType.FILTER)
        self.assertEqual(tokens[1].filter_key, "rating")

    def test_search_tokenizer_keeps_negated_unknown_colon_tags_literal(self):
        from app.services.search import TokenType, tokenize

        tokens = tokenize("-beatrice_re:zero -safety:unsafe")

        self.assertEqual(tokens[0].type, TokenType.NEGATED_TAG)
        self.assertEqual(tokens[0].value, "beatrice_re:zero")
        self.assertEqual(tokens[1].type, TokenType.NEGATED_FILTER)
        self.assertEqual(tokens[1].filter_key, "safety")

    def test_qwen_device_map_respects_cpu_and_gpu_availability(self):
        from app.services.auto_tagger import _qwen_device_map

        self.assertEqual(_qwen_device_map("cpu"), "cpu")
        with patch("app.services.auto_tagger._torch_runtime_info", return_value={"cudaAvailable": False}):
            self.assertEqual(_qwen_device_map("auto"), "cpu")
            with self.assertRaises(RuntimeError):
                _qwen_device_map("gpu")
        with patch("app.services.auto_tagger._torch_runtime_info", return_value={"cudaAvailable": True}), \
             patch("app.services.auto_tagger._ensure_qwen_gpu_headroom") as headroom:
            self.assertEqual(_qwen_device_map("auto"), {"": 0})
            headroom.assert_called_once()

    def test_qwen_gpu_headroom_blocks_low_free_vram(self):
        from app.services.auto_tagger import _ensure_qwen_gpu_headroom

        with patch("app.services.auto_tagger._qwen_gpu_memory_info", return_value={"freeGb": 2.0, "totalGb": 24.0}):
            with self.assertRaisesRegex(RuntimeError, "free VRAM"):
                _ensure_qwen_gpu_headroom()

    def test_onnx_providers_prefer_cuda_with_cpu_fallback(self):
        from app.services.auto_tagger import _onnx_providers

        class Ort:
            @staticmethod
            def get_available_providers():
                return ["CUDAExecutionProvider", "CPUExecutionProvider"]

        self.assertEqual(_onnx_providers(Ort), ["CUDAExecutionProvider", "CPUExecutionProvider"])

    def test_onnx_session_retries_cpu_when_gpu_provider_fails(self):
        from app.services.auto_tagger import _create_onnx_session

        class Session:
            def __init__(self, providers):
                self.providers = providers

        class Ort:
            calls = []

            @staticmethod
            def get_available_providers():
                return ["CUDAExecutionProvider", "CPUExecutionProvider"]

            @staticmethod
            def InferenceSession(path, providers):
                Ort.calls.append(providers)
                if providers[0] == "CUDAExecutionProvider":
                    raise RuntimeError("DLL initialization routine failed")
                return Session(providers)

        session = _create_onnx_session(Ort, "model.onnx")

        self.assertEqual(session.providers, ["CPUExecutionProvider"])
        self.assertEqual(Ort.calls, [["CUDAExecutionProvider", "CPUExecutionProvider"], ["CPUExecutionProvider"]])

    def test_onnx_runtime_info_marks_import_failure_unavailable(self):
        from app.services.auto_tagger import _onnx_runtime_info

        with patch("app.services.auto_tagger.find_spec", return_value=True), \
             patch.dict("sys.modules", {"onnxruntime": None}):
            info = _onnx_runtime_info()

        self.assertFalse(info["available"])
        self.assertIn("error", info)

    def test_whisper_audio_seconds_is_capped_to_model_window(self):
        from app.services.auto_tagger import AutoTagOptions, _whisper_audio_seconds

        self.assertEqual(_whisper_audio_seconds(AutoTagOptions(videoMaxDurationSeconds=900)), 30)
        self.assertEqual(_whisper_audio_seconds(AutoTagOptions(videoMaxDurationSeconds=12)), 12)

    def test_whisper_transcribe_uses_short_audio_window(self):
        from app.services.auto_tagger import AutoTagOptions, _whisper_tagger

        old_pipeline = _whisper_tagger._pipeline
        old_loaded = _whisper_tagger._loaded
        pipeline = Mock(return_value={"text": "vote campaign"})
        _whisper_tagger._pipeline = pipeline
        _whisper_tagger._loaded = True
        try:
            with patch("app.services.auto_tagger._extract_audio", return_value=True) as extract_audio:
                result = _whisper_tagger.transcribe_video(Path("sample.mp4"), AutoTagOptions(videoMaxDurationSeconds=900))
        finally:
            _whisper_tagger._pipeline = old_pipeline
            _whisper_tagger._loaded = old_loaded

        extract_audio.assert_called_once()
        self.assertEqual(extract_audio.call_args.args[2], 30)
        pipeline.assert_called_once_with(str(extract_audio.call_args.args[1]), return_timestamps=False)
        self.assertIn("has_speech", result.tags)
        self.assertIn("political_audio", result.tags)

    def test_tag_media_async_offloads_blocking_work(self):
        from app.services.auto_tag_jobs import _tag_media_async
        from app.services.auto_tagger import AutoTagOptions, AutoTagResult

        expected = AutoTagResult(tags=["offloaded"], enabled=True)
        with patch("app.services.auto_tag_jobs.asyncio.to_thread", return_value=expected) as to_thread:
            result = asyncio.run(_tag_media_async(Path("sample.png"), AutoTagOptions()))

        self.assertIs(result, expected)
        self.assertEqual(to_thread.call_args.args[0].__name__, "tag_media")


if __name__ == "__main__":
    unittest.main()
