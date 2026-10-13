"""Shared fixtures for the auto-tagging test files (not a test module itself)."""
import os
import sys
import tempfile
import time
import unittest
import asyncio
from pathlib import Path


BACKEND_PATH = str(Path(__file__).resolve().parents[1] / "backend")


def add_backend_path():
    if BACKEND_PATH not in sys.path:
        sys.path.insert(0, BACKEND_PATH)


class AutoTagApiTestCase(unittest.TestCase):
    """A throwaway app with every NEKO_* path in a temp dir and a bootstrapped admin session."""

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
        add_backend_path()

        from fastapi.testclient import TestClient
        from app.main import app
        from app.database import reset_engine_for_tests

        # app.database's engine is a module-level singleton fixed at first
        # import; under `unittest discover` every test class in the process
        # would otherwise share whichever class's database happened to be
        # created first, regardless of this class's own NEKO_DATA_DIR above.
        reset_engine_for_tests()

        cls.client = TestClient(app)
        cls.client.__enter__()

        # Posts/uploads/etc. require an authenticated session; bootstrap once
        # and let the cookie persist for every test method in this class.
        boot = cls.client.post(
            "/api/auth/bootstrap-admin", json={"username": "test-admin", "password": "test-admin-password"}
        )
        assert boot.status_code == 200, boot.text

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        from app.database import engine

        asyncio.run(engine.dispose())
        for key, value in cls._previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
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

    def _set_auto_tag_settings(self, **changes):
        settings = self.client.get("/api/auto-tags/settings").json()
        settings.update(changes)
        response = self.client.put("/api/auto-tags/settings", json={"settings": settings})
        self.assertEqual(response.status_code, 200, response.text)
        self.addCleanup(self._restore_auto_tag_setting, changes)

    def _restore_auto_tag_setting(self, changes):
        settings = self.client.get("/api/auto-tags/settings").json()
        for key in changes:
            settings[key] = False
        self.client.put("/api/auto-tags/settings", json={"settings": settings})

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
