import io
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image


class UploadJobApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls._env_keys = [
            "NEKO_CONFIG_DIR",
            "NEKO_CONFIG_FILE",
            "NEKO_DATA_DIR",
            "NEKO_LOGS_DIR",
            "NEKO_MODELS_DIR",
            "NEKO_RUNTIMES_DIR",
            "NEKO_CACHE_DIR",
        ]
        cls._previous_env = {key: os.environ.get(key) for key in cls._env_keys}
        root = Path(cls.tmp.name)
        os.environ.update({
            "NEKO_CONFIG_DIR": str(root / "config"),
            "NEKO_CONFIG_FILE": str(root / "config" / "settings.json"),
            "NEKO_DATA_DIR": str(root / "data"),
            "NEKO_LOGS_DIR": str(root / "logs"),
            "NEKO_MODELS_DIR": str(root / "models"),
            "NEKO_RUNTIMES_DIR": str(root / "runtimes"),
            "NEKO_CACHE_DIR": str(root / "cache"),
        })
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
        from fastapi.testclient import TestClient
        from app.main import app

        cls.client_context = TestClient(app)
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        import asyncio
        from app.database import engine

        asyncio.run(engine.dispose())
        sys.path.pop(0)
        for key, value in cls._previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.tmp.cleanup()

    def _metadata(self):
        return {
            "provider": "youtube",
            "extractor": "youtube",
            "canonicalUrl": "https://www.youtube.com/watch?v=test",
            "title": "Test video",
            "uploader": "Test channel",
            "duration": 300.0,
            "durationMs": 300_000,
            "thumbnail": None,
            "width": 1920,
            "height": 1080,
        }

    def _wait_for(self, job_id, expected):
        body = None
        for _ in range(100):
            response = self.client.get(f"/api/upload-jobs/{job_id}")
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            if body["status"] in expected:
                return body
            time.sleep(0.02)
        self.fail(f"job did not reach {expected}: {body}")

    def test_rejects_unsupported_provider_before_job_creation(self):
        response = self.client.post(
            "/api/upload-jobs",
            json={"kind": "remote_clip", "sourceUrl": "https://example.com/video", "profile": "x-standard"},
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["detail"]["code"], "unsupported_provider")

    def test_rejects_playlist_parameters(self):
        response = self.client.post(
            "/api/upload-jobs",
            json={"kind": "remote_clip", "sourceUrl": "https://youtube.com/watch?v=test&list=PL123", "profile": "x-standard"},
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["detail"]["code"], "playlist_not_supported")

    def test_probe_job_is_durable_and_reports_completed_stages(self):
        with patch("app.services.upload_jobs._probe_source", return_value=self._metadata()), \
             patch("app.services.upload_jobs.check_ffmpeg_available", return_value=True), \
             patch("app.services.upload_jobs.shutil.which", return_value="ffprobe"):
            response = self.client.post(
                "/api/upload-jobs",
                headers={"Idempotency-Key": "probe-test"},
                json={"kind": "remote_clip", "sourceUrl": "https://youtu.be/test", "profile": "x-standard"},
            )
            self.assertEqual(response.status_code, 202, response.text)
            first = response.json()
            completed = self._wait_for(first["id"], {"awaiting_selection", "failed"})

            self.assertEqual(completed["status"], "awaiting_selection", completed)
            self.assertEqual(completed["readyFor"], "selection")
            self.assertEqual(completed["source"]["durationMs"], 300_000)
            self.assertEqual(completed["overallProgress"], 100)
            self.assertTrue(all(stage["state"] == "completed" for stage in completed["stages"]))

            repeated = self.client.post(
                "/api/upload-jobs",
                headers={"Idempotency-Key": "probe-test"},
                json={"kind": "remote_clip", "sourceUrl": "https://youtu.be/test", "profile": "x-standard"},
            )
            self.assertEqual(repeated.status_code, 202, repeated.text)
            self.assertEqual(repeated.json()["id"], first["id"])

    def test_selection_validation_enforces_x_limits(self):
        from app.services.upload_jobs import JobError, validate_selection

        self.assertEqual(validate_selection(1_000, 2_000, 10), (1_000, 2_000))
        for start, end, duration, code in [
            (-1, 1_000, 10, "invalid_selection"),
            (2_000, 1_000, 10, "invalid_selection"),
            (0, 250, 10, "clip_too_short"),
            (0, 140_001, 300, "clip_too_long"),
            (9_000, 11_000, 10, "selection_out_of_bounds"),
        ]:
            with self.subTest(code=code), self.assertRaises(JobError) as caught:
                validate_selection(start, end, duration)
            self.assertEqual(caught.exception.code, code)

    def test_artifact_paths_cannot_escape_cache(self):
        from app.models import UploadArtifact
        from app.services.upload_jobs import JobError, artifact_path

        artifact = UploadArtifact(relative_path="../outside.mp4", filename="outside.mp4", role="render", job_id="x")
        with self.assertRaises(JobError) as caught:
            artifact_path(artifact)
        self.assertEqual(caught.exception.code, "invalid_artifact")

    def test_local_job_streams_content_and_supports_range_reads(self):
        content = b"\x89PNG\r\n\x1a\n" + (b"test" * 64)
        created = self.client.post(
            "/api/upload-jobs",
            headers={"Idempotency-Key": "local-stream"},
            json={"kind": "local", "filename": "sample.png", "size": len(content), "mimeType": "image/png"},
        )
        self.assertEqual(created.status_code, 202, created.text)
        job = created.json()
        self.assertEqual(job["readyFor"], "content")

        uploaded = self.client.put(
            f"/api/upload-jobs/{job['id']}/content",
            headers={"Content-Type": "image/png"},
            content=content,
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        ready = uploaded.json()
        self.assertEqual(ready["status"], "content_ready")
        self.assertEqual(ready["metrics"]["downloadedBytes"], len(content))
        artifact = ready["artifacts"][0]
        self.assertEqual(artifact["fileSize"], len(content))

        partial = self.client.get(artifact["contentUrl"], headers={"Range": "bytes=0-7"})
        self.assertEqual(partial.status_code, 206, partial.text)
        self.assertEqual(partial.content, content[:8])

    def test_x_filter_prevents_upscale_and_enforces_aspect_limit(self):
        from app.services.upload_jobs import x_video_filter

        landscape = x_video_filter(True)
        portrait = x_video_filter(False)
        self.assertIn("min(iw,1280)", landscape)
        self.assertIn("min(ih,720)", landscape)
        self.assertIn("ceil(ih/3/2)*2", landscape)
        self.assertIn("min(iw,720)", portrait)
        self.assertIn("min(ih,1280)", portrait)

    def test_local_publication_uses_registered_artifact_bytes(self):
        payload = io.BytesIO()
        Image.new("RGB", (8, 8), (20, 80, 160)).save(payload, format="PNG")
        content = payload.getvalue()
        created = self.client.post(
            "/api/upload-jobs",
            json={"kind": "local", "filename": "publish.png", "size": len(content), "mimeType": "image/png"},
        ).json()
        ready_response = self.client.put(f"/api/upload-jobs/{created['id']}/content", content=content)
        self.assertEqual(ready_response.status_code, 200, ready_response.text)
        ready = ready_response.json()
        artifact = ready["artifacts"][0]

        publish = self.client.post(
            f"/api/upload-jobs/{created['id']}/publish",
            headers={"Idempotency-Key": "local-publish"},
            json={
                "artifactId": artifact["id"],
                "revision": ready["revision"],
                "tags": ["durable_upload"],
                "safety": "safe",
                "source": "https://example.test/source",
                "autoTag": False,
            },
        )
        self.assertEqual(publish.status_code, 202, publish.text)
        completed = self._wait_for(created["id"], {"completed", "failed"})
        self.assertEqual(completed["status"], "completed", completed)
        post = self.client.get(f"/api/posts/{completed['resultPostId']}").json()
        self.assertEqual(post["sha256"], artifact["sha256"])
        self.assertEqual(post["source"], "https://example.test/source")


if __name__ == "__main__":
    unittest.main()
