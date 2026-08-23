import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path


class SyncIsolationTests(unittest.TestCase):
    """Phase 4: the Android/offline sync endpoints (routers/sync.py) only
    ever see or touch the calling user's own library - tags included, since
    tags are private per library now, same as posts.
    """

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
        from app.main import app
        from app.database import reset_engine_for_tests

        reset_engine_for_tests()

        cls.client = TestClient(app)
        cls.client.__enter__()

        boot = cls.client.post("/api/auth/bootstrap-admin", json={"username": "root", "password": "rootpassword1"})
        assert boot.status_code == 200, boot.text
        created = cls.client.post("/api/auth/users", json={"username": "alice", "password": "alicepassword1"})
        assert created.status_code == 200, created.text
        created = cls.client.post("/api/auth/users", json={"username": "bob", "password": "bobpassword1"})
        assert created.status_code == 200, created.text
        cls.client.post("/api/auth/logout")

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

    def _login(self, username, password):
        resp = self.client.post("/api/auth/login", json={"username": username, "password": password})
        self.assertEqual(resp.status_code, 200, resp.text)

    def _logout(self):
        self.client.post("/api/auth/logout")

    def _upload_token(self, color):
        from PIL import Image

        stamp = time.time_ns()
        image_path = Path(self.tmp.name) / f"sync-{stamp}.png"
        Image.new("RGB", (16, 16), color).save(image_path)
        with image_path.open("rb") as fh:
            upload = self.client.post("/api/uploads", files={"content": (image_path.name, fh, "image/png")})
        self.assertEqual(upload.status_code, 200, upload.text)
        return upload.json()["token"]

    def test_01_push_creates_a_post_owned_by_the_pushing_user(self):
        self._login("alice", "alicepassword1")
        token = self._upload_token((1, 2, 3))
        push = self.client.post(
            "/api/sync/push",
            json={"changes": [{"type": "post", "op": "upsert", "contentToken": token, "tags": ["a_tag"]}]},
        )
        self.assertEqual(push.status_code, 200, push.text)
        result = push.json()["results"][0]
        self.assertEqual(result["status"], "created")
        self.__class__.alice_sha = result["sha256"]
        self._logout()

    def test_02_pull_only_returns_the_caller_own_posts(self):
        self._login("bob", "bobpassword1")
        changes = self.client.get("/api/sync/changes")
        self.assertEqual(changes.status_code, 200, changes.text)
        shas = [c["key"] for c in changes.json()["changes"] if c["type"] == "post"]
        self.assertNotIn(self.alice_sha, shas)
        self._logout()

        self._login("alice", "alicepassword1")
        changes = self.client.get("/api/sync/changes")
        shas = [c["key"] for c in changes.json()["changes"] if c["type"] == "post"]
        self.assertIn(self.alice_sha, shas)
        self._logout()

    def test_03_tags_are_private_like_posts(self):
        # Bob never tagged anything with "a_tag" (alice did, in her own
        # library) - it must not appear in his sync feed.
        self._login("bob", "bobpassword1")
        changes = self.client.get("/api/sync/changes")
        tag_keys = [c["key"] for c in changes.json()["changes"] if c["type"] == "tag"]
        self.assertNotIn("a_tag", tag_keys)
        self._logout()

        self._login("alice", "alicepassword1")
        changes = self.client.get("/api/sync/changes")
        tag_keys = [c["key"] for c in changes.json()["changes"] if c["type"] == "tag"]
        self.assertIn("a_tag", tag_keys)
        self._logout()

    def test_04_push_cannot_edit_another_user_post_by_sha(self):
        self._login("bob", "bobpassword1")
        push = self.client.post(
            "/api/sync/push",
            json={"changes": [{"type": "post", "op": "upsert", "sha256": self.alice_sha, "safety": "unsafe"}]},
        )
        self.assertEqual(push.status_code, 200, push.text)
        result = push.json()["results"][0]
        self.assertEqual(result["status"], "error")
        self._logout()

        # Confirm alice's post was not actually touched.
        self._login("alice", "alicepassword1")
        listing = self.client.get("/api/posts")
        post = next(p for p in listing.json()["results"] if p["sha256"] == self.alice_sha)
        self.assertEqual(post["safety"], "safe")
        self._logout()

    def test_05_push_duplicate_sha256_across_users_errors_without_leaking(self):
        self._login("bob", "bobpassword1")
        token = self._upload_token((1, 2, 3))  # identical bytes to alice's post
        push = self.client.post(
            "/api/sync/push",
            json={"changes": [{"type": "post", "op": "upsert", "contentToken": token, "tags": []}]},
        )
        self.assertEqual(push.status_code, 200, push.text)
        result = push.json()["results"][0]
        self.assertEqual(result["status"], "error")
        self.assertNotIn("serverId", result)
        self._logout()

    def test_06_favorite_push_and_pull_are_per_user(self):
        self._login("alice", "alicepassword1")
        push = self.client.post(
            "/api/sync/push",
            json={"changes": [{"type": "favorite", "op": "upsert", "sha256": self.alice_sha}]},
        )
        self.assertEqual(push.json()["results"][0]["status"], "favorited")
        changes = self.client.get("/api/sync/changes")
        fav = next(c for c in changes.json()["changes"] if c["type"] == "favorite" and c["key"] == self.alice_sha)
        self.assertEqual(fav["op"], "upsert")
        self._logout()

        # Bob can't even see alice's post, let alone its favorite state.
        self._login("bob", "bobpassword1")
        push = self.client.post(
            "/api/sync/push",
            json={"changes": [{"type": "favorite", "op": "upsert", "sha256": self.alice_sha}]},
        )
        self.assertEqual(push.json()["results"][0]["status"], "error")
        self._logout()


if __name__ == "__main__":
    unittest.main()
