import asyncio
import http.server
import io
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


class _ImageHandler(http.server.BaseHTTPRequestHandler):
    body = b""

    def do_GET(self):  # noqa: N802 - http.server naming
        if self.path.startswith("/slow"):
            time.sleep(1.5)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *_args):
        pass


class UrlUploadTests(unittest.TestCase):
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
        tmp_root = Path(cls.tmp.name)
        os.environ["NEKO_CONFIG_DIR"] = str(tmp_root / "config")
        os.environ["NEKO_CONFIG_FILE"] = str(tmp_root / "config" / "settings.json")
        os.environ["NEKO_DATA_DIR"] = str(tmp_root / "data")
        os.environ["NEKO_LOGS_DIR"] = str(tmp_root / "logs")
        os.environ["NEKO_MODELS_DIR"] = str(tmp_root / "models")
        os.environ["NEKO_RUNTIMES_DIR"] = str(tmp_root / "runtimes")
        os.environ["NEKO_CACHE_DIR"] = str(tmp_root / "cache")
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

        from fastapi.testclient import TestClient
        from PIL import Image
        from app.main import app
        from app.database import reset_engine_for_tests

        reset_engine_for_tests()
        cls.client = TestClient(app)
        cls.client.__enter__()
        boot = cls.client.post(
            "/api/auth/bootstrap-admin", json={"username": "test-admin", "password": "test-admin-password"}
        )
        assert boot.status_code == 200, boot.text

        image = io.BytesIO()
        Image.new("RGB", (300, 300), (12, 200, 90)).save(image, format="PNG")
        _ImageHandler.body = image.getvalue()
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _ImageHandler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.image_url = f"http://127.0.0.1:{cls.server.server_address[1]}/picture.png"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.client.__exit__(None, None, None)
        from app.database import engine

        asyncio.run(engine.dispose())
        for key, value in cls._previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.tmp.cleanup()

    def test_download_streams_to_disk_and_reports_progress(self):
        progress_id = "test-progress-0001"
        upload = self.client.post("/api/uploads/from-url", json={"url": self.image_url, "progressId": progress_id})
        self.assertEqual(upload.status_code, 200, upload.text)
        self.assertEqual(upload.json()["size"], len(_ImageHandler.body))

        progress = self.client.get(f"/api/uploads/from-url/progress/{progress_id}")
        self.assertEqual(progress.status_code, 200, progress.text)
        self.assertEqual(
            progress.json(),
            {"received": len(_ImageHandler.body), "total": len(_ImageHandler.body), "done": True},
        )

        created = self.client.post(
            "/api/posts", json={"contentToken": upload.json()["token"], "tags": ["streamed"], "autoTag": False}
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["width"], 300)

    def test_the_same_file_cannot_download_twice_at_once(self):
        slow_url = self.image_url.replace("/picture.png", "/slow.png")
        first = {}
        worker = threading.Thread(
            target=lambda: first.update(response=self.client.post("/api/uploads/from-url", json={"url": slow_url}))
        )
        worker.start()
        time.sleep(0.5)
        second = self.client.post("/api/uploads/from-url", json={"url": slow_url})
        worker.join()

        self.assertEqual(second.status_code, 409, second.text)
        self.assertIn("already downloading", second.json()["detail"])
        self.assertEqual(first["response"].status_code, 200, first["response"].text)
        # Finished downloads release the file again.
        again = self.client.post("/api/uploads/from-url", json={"url": slow_url})
        self.assertEqual(again.status_code, 200, again.text)

    def test_signed_sankaku_links_to_one_file_count_as_the_same_download(self):
        from urllib.parse import urlparse
        from app.routers.uploads_fetch import _download_key

        first = urlparse("https://v.sankakucomplex.com/data/ae/65/ae65.mp4?e=1&expires=1&m=a&token=x")
        second = urlparse("https://v.sankakucomplex.com/data/ae/65/ae65.mp4?e=2&expires=2&m=b&token=y")
        other = urlparse("https://example.com/a.mp4?v=1")
        self.assertEqual(_download_key(first), _download_key(second))
        self.assertNotEqual(_download_key(other), _download_key(urlparse("https://example.com/a.mp4?v=2")))

    def test_unknown_or_unfollowed_download_has_no_progress(self):
        self.assertEqual(self.client.get("/api/uploads/from-url/progress/not-a-real-id").status_code, 404)
        # A bad id is simply not followed; the download itself still works.
        upload = self.client.post("/api/uploads/from-url", json={"url": self.image_url, "progressId": "../x"})
        self.assertEqual(upload.status_code, 200, upload.text)
        self.assertEqual(self.client.get("/api/uploads/from-url/progress/..%2Fx").status_code, 404)


if __name__ == "__main__":
    unittest.main()
