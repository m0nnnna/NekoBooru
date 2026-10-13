import time
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_tag_support as support


class AutoTagModelApiTests(support.AutoTagApiTestCase):
    """Model catalog, download, load, unload and cache endpoints, remote inference, and runtime restart."""

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

    def test_download_model_starts_the_wd_download_and_returns_status(self):
        from app.services.auto_tagger import models as at_models

        with patch.object(at_models, "start_model_download") as start,                 patch.object(at_models, "status", return_value={"downloadJob": {"id": "job"}}) as status:
            result = at_models.download_model()

        start.assert_called_once_with(["wd"])
        status.assert_called_once_with()
        self.assertEqual(result, {"downloadJob": {"id": "job"}})

    def test_concurrent_infer_requests_serialize_without_blocking_the_api(self):
        """Several extension popups tagging at once must queue, not collide."""
        import threading
        from PIL import Image
        from app.services import auto_tagger

        state = {"concurrent": 0, "peak": 0}
        counter_lock = threading.Lock()

        def fake_pipeline(path, opts):
            with counter_lock:
                state["concurrent"] += 1
                state["peak"] = max(state["peak"], state["concurrent"])
            time.sleep(0.15)
            with counter_lock:
                state["concurrent"] -= 1
            return auto_tagger.AutoTagResult(enabled=True, model="fake", tags=["x"])

        sample = Path(self.tmp.name) / "concurrent.png"
        Image.new("RGB", (8, 8), "white").save(sample)
        payload = sample.read_bytes()
        results = {}

        def worker(index):
            response = self.client.post(
                "/api/auto-tags/infer",
                files={"file": ("concurrent.png", payload, "image/png")},
                data={"options": "{}"},
            )
            results[index] = response.status_code

        with patch.object(auto_tagger.dispatch, "_infer_local_locked", fake_pipeline):
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
            for thread in threads:
                thread.start()
            time.sleep(0.2)
            # The API must still answer while inference is saturated; running the
            # pipeline inline in an async endpoint used to block the event loop.
            probe = self.client.get("/api/auto-tags/models/load-job")
            for thread in threads:
                thread.join(timeout=15)

        self.assertEqual(set(results.values()), {200})
        self.assertEqual(probe.status_code, 200)
        self.assertEqual(state["peak"], 1, "inference must not run concurrently")

    def test_model_catalog_lists_downloadable_models(self):
        response = self.client.get("/api/auto-tags/models")

        self.assertEqual(response.status_code, 200, response.text)
        ids = {model["id"] for model in response.json()["models"]}
        self.assertIn("wd", ids)
        self.assertIn("pixai", ids)
        self.assertIn("camie", ids)
        self.assertIn("cl", ids)
        self.assertIn("qwen", ids)
        self.assertIn("qwen_gguf_q4", ids)
        self.assertIn("qwen_gguf_q8", ids)
        self.assertIn("ocr", ids)
        self.assertIn("whisper", ids)
        by_id = {model["id"]: model for model in response.json()["models"]}
        self.assertIn("downloadSize", by_id["qwen"])
        self.assertIn("vramRequirement", by_id["qwen"])
        self.assertIn("loaded", by_id["wd"])
        self.assertEqual(by_id["qwen_gguf_q4"]["backend"], "gguf")
        self.assertEqual(by_id["qwen_gguf_q8"]["quantization"], "Q8_0")

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
        self.assertIn("pixai", start.call_args.args[0])
        # CL Tagger is gated and 2.3 GB, so it is opt-in rather than part of "download all".
        self.assertNotIn("cl", start.call_args.args[0])

    def test_download_all_uses_selected_semantic_backend_only(self):
        fake_job = {
            "id": "job-gguf",
            "status": "queued",
            "modelIds": ["qwen_gguf_q4"],
            "models": {},
        }
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["semanticModelId"] = "qwen_gguf_q4"
        response = self.client.put("/api/auto-tags/settings", json={"settings": settings})
        self.assertEqual(response.status_code, 200, response.text)

        try:
            with patch("app.routers.auto_tags.start_model_download", return_value=fake_job) as start:
                response = self.client.post("/api/auto-tags/models/download-all")

            self.assertEqual(response.status_code, 200, response.text)
            model_ids = start.call_args.args[0]
            self.assertIn("qwen_gguf_q4", model_ids)
            self.assertNotIn("qwen", model_ids)
            self.assertNotIn("qwen_gguf_q8", model_ids)
        finally:
            settings["semanticModelId"] = "qwen"
            self.client.put("/api/auto-tags/settings", json={"settings": settings})

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

    def test_model_download_cancel_marks_queued_models_cancelled(self):
        from app.services import auto_tagger
        from app.services.auto_tagger import cancel_model_download, current_download_job

        now = time.time()
        with auto_tagger._download_lock:
            previous_job = auto_tagger._download_job
            auto_tagger._download_job = {
                "id": "job-cancel",
                "status": "running",
                "cancelRequested": False,
                "modelIds": ["ocr", "whisper"],
                "total": 2,
                "completed": 0,
                "failed": 0,
                "error": None,
                "createdAt": now,
                "updatedAt": now,
                "models": {
                    "ocr": {
                        "id": "ocr",
                        "name": "TrOCR Printed",
                        "repoId": "microsoft/trocr-base-printed",
                        "status": "queued",
                        "current": "",
                        "updatedAt": now,
                    },
                    "whisper": {
                        "id": "whisper",
                        "name": "Whisper Small",
                        "repoId": "openai/whisper-small",
                        "status": "queued",
                        "current": "",
                        "updatedAt": now,
                    },
                },
            }

        try:
            cancelled = cancel_model_download()
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual(cancelled["models"]["ocr"]["status"], "cancelled")
            self.assertEqual(cancelled["models"]["whisper"]["status"], "cancelled")
            self.assertEqual(current_download_job()["status"], "cancelled")
        finally:
            with auto_tagger._download_lock:
                auto_tagger._download_job = previous_job

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

    def test_runtime_restart_route_reports_unavailable_without_handler(self):
        from app.services.app_restart import clear_restart_handler

        clear_restart_handler()
        status = self.client.get("/api/runtime/status")
        self.assertEqual(status.status_code, 200, status.text)
        self.assertFalse(status.json()["restart"]["available"])

        response = self.client.post("/api/runtime/restart")
        self.assertEqual(response.status_code, 409)

    def test_runtime_restart_route_invokes_registered_handler(self):
        from app.services.app_restart import clear_restart_handler, register_restart_handler

        try:
            register_restart_handler(lambda: {"status": "restarting", "message": "ok"})
            response = self.client.post("/api/runtime/restart")

            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], "restarting")
        finally:
            clear_restart_handler()

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


if __name__ == "__main__":
    unittest.main()
