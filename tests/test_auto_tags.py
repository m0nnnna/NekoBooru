import os
import sys
import tempfile
import time
import unittest
import asyncio
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
        token = upload.json()["token"]
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


class AutoTagUnitTests(unittest.TestCase):
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

    def test_wd_can_be_disabled_for_per_run_overrides(self):
        from app.services.auto_tagger import AutoTagOptions, _tag_image

        with patch("app.services.auto_tagger._wd_tagger.tag_image") as wd_tag:
            result = _tag_image(Path("sample.png"), AutoTagOptions(wdEnabled=False))

        wd_tag.assert_not_called()
        self.assertEqual(result.error, "no_models_enabled")

    def test_qwen_load_job_uses_longer_estimate(self):
        from app.services.auto_tagger import _new_load_job

        job = _new_load_job("qwen", status="queued", progress=0, message="Queued")

        self.assertGreaterEqual(job["estimatedSeconds"], 90)

    def test_torch_device_setting_validates_to_auto(self):
        from app.services.auto_tagger import validate_options

        opts = validate_options({"torchDevice": "space_laser"})

        self.assertEqual(opts.torchDevice, "auto")

    def test_qwen_device_map_respects_cpu_and_gpu_availability(self):
        from app.services.auto_tagger import _qwen_device_map

        self.assertEqual(_qwen_device_map("cpu"), "cpu")
        with patch("app.services.auto_tagger._torch_runtime_info", return_value={"cudaAvailable": False}):
            self.assertEqual(_qwen_device_map("auto"), "cpu")
            with self.assertRaises(RuntimeError):
                _qwen_device_map("gpu")

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
