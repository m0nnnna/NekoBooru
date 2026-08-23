import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path


class PostIsolationTests(unittest.TestCase):
    """Phase 3: posts/favorites are private per-owner unless shared.

    Exercises the owner_id scoping added to routers/posts.py and
    services/search.py - a second user must not be able to see, edit, or
    favorite-as-someone-else another user's content, and sharing a library
    only grants read access.
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

        # app.database's engine is a module-level singleton fixed at first
        # import; under `unittest discover` every test class in the process
        # would otherwise share whichever class's database happened to be
        # created first, regardless of this class's own NEKO_DATA_DIR above -
        # this class specifically needs a database with zero users in it, so
        # this isn't optional here the way it might look elsewhere.
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

    def _upload_image_post(self, color=(1, 2, 3)):
        from PIL import Image

        stamp = time.time_ns()
        image_path = Path(self.tmp.name) / f"sample-{stamp}.png"
        Image.new("RGB", (16, 16), color).save(image_path)
        with image_path.open("rb") as fh:
            upload = self.client.post("/api/uploads", files={"content": (image_path.name, fh, "image/png")})
        self.assertEqual(upload.status_code, 200, upload.text)
        token = upload.json()["token"]
        created = self.client.post(
            "/api/posts",
            json={"contentToken": token, "tags": [], "safety": "safe", "autoTag": False},
        )
        self.assertEqual(created.status_code, 200, created.text)
        return created.json()

    def test_01_post_is_private_to_its_owner(self):
        self._login("alice", "alicepassword1")
        post = self._upload_image_post(color=(10, 20, 30))
        self.__class__.alice_post = post
        self._logout()

        self._login("bob", "bobpassword1")
        listing = self.client.get("/api/posts")
        self.assertEqual(listing.status_code, 200)
        ids = [p["id"] for p in listing.json()["results"]]
        self.assertNotIn(post["id"], ids)

        direct = self.client.get(f"/api/posts/{post['id']}")
        self.assertEqual(direct.status_code, 404)

        media = self.client.get(post["contentUrl"])
        self.assertEqual(media.status_code, 404)
        thumb = self.client.get(post["thumbUrl"])
        self.assertEqual(thumb.status_code, 404)
        self._logout()

    def test_02_owner_can_see_and_edit_their_own_post(self):
        self._login("alice", "alicepassword1")
        post = self.alice_post
        direct = self.client.get(f"/api/posts/{post['id']}")
        self.assertEqual(direct.status_code, 200)

        updated = self.client.put(f"/api/posts/{post['id']}", json={"source": "https://example.test/mine"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["source"], "https://example.test/mine")
        self._logout()

    def test_03_non_owner_cannot_mutate_even_if_they_learn_the_id(self):
        self._login("bob", "bobpassword1")
        post = self.alice_post
        # Not visible, so mutations 404 (not leaking that it exists).
        resp = self.client.put(f"/api/posts/{post['id']}", json={"source": "https://evil.test"})
        self.assertEqual(resp.status_code, 404)
        resp = self.client.delete(f"/api/posts/{post['id']}")
        self.assertEqual(resp.status_code, 404)
        self._logout()

    def test_04_duplicate_upload_across_users_is_blocked_without_leaking_details(self):
        # Bob uploads the exact same image bytes alice already owns.
        self._login("bob", "bobpassword1")
        from PIL import Image

        image_path = Path(self.tmp.name) / "identical.png"
        Image.new("RGB", (16, 16), (10, 20, 30)).save(image_path)
        with image_path.open("rb") as fh:
            upload = self.client.post("/api/uploads", files={"content": (image_path.name, fh, "image/png")})
        self.assertEqual(upload.status_code, 200, upload.text)
        token = upload.json()["token"]
        created = self.client.post(
            "/api/posts",
            json={"contentToken": token, "tags": [], "safety": "safe", "autoTag": False},
        )
        self.assertEqual(created.status_code, 409)
        detail = created.json()["detail"]
        self.assertIsNone(detail["postId"])
        self.assertIsNone(detail["post"])
        self.assertIsNone(detail["postUrl"])
        self._logout()

    def test_05_sharing_grants_read_only_access(self):
        self._login("alice", "alicepassword1")
        shares = self.client.put("/api/auth/shares", json={"granteeUsernames": ["bob"]})
        self.assertEqual(shares.status_code, 200, shares.text)
        self._logout()

        self._login("bob", "bobpassword1")
        post = self.alice_post
        direct = self.client.get(f"/api/posts/{post['id']}")
        self.assertEqual(direct.status_code, 200, direct.text)

        listing = self.client.get("/api/posts")
        ids = [p["id"] for p in listing.json()["results"]]
        self.assertIn(post["id"], ids)

        # Read access does not imply write access.
        resp = self.client.put(f"/api/posts/{post['id']}", json={"source": "https://evil.test"})
        self.assertNotEqual(resp.status_code, 200)
        self._logout()

    def test_06_favorites_are_per_user(self):
        post = self.alice_post

        self._login("bob", "bobpassword1")
        fav = self.client.post(f"/api/posts/{post['id']}/favorite")
        self.assertEqual(fav.status_code, 200, fav.text)
        self.assertTrue(fav.json()["isFavorited"])
        bob_view = self.client.get(f"/api/posts/{post['id']}")
        self.assertTrue(bob_view.json()["isFavorited"])
        self._logout()

        self._login("alice", "alicepassword1")
        alice_view = self.client.get(f"/api/posts/{post['id']}")
        self.assertFalse(alice_view.json()["isFavorited"])

        # Revoke the share; bob should lose visibility again.
        self.client.put("/api/auth/shares", json={"granteeUsernames": []})
        self._logout()

        self._login("bob", "bobpassword1")
        after_revoke = self.client.get(f"/api/posts/{post['id']}")
        self.assertEqual(after_revoke.status_code, 404)
        self._logout()

    def test_07_stats_and_dashboard_do_not_count_other_users_posts(self):
        # Sharing was revoked in test_06, so bob (0 posts of his own) must not
        # see alice's post reflected in any aggregate count.
        self._login("bob", "bobpassword1")
        stats = self.client.get("/api/settings/stats")
        self.assertEqual(stats.status_code, 200, stats.text)
        self.assertEqual(stats.json()["total_files"], 0)

        dashboard = self.client.get("/api/settings/dashboard")
        self.assertEqual(dashboard.status_code, 200, dashboard.text)
        self.assertEqual(dashboard.json()["totals"]["posts"], 0)

        top_level_stats = self.client.get("/api/stats")
        self.assertEqual(top_level_stats.status_code, 200, top_level_stats.text)
        self.assertEqual(top_level_stats.json()["posts"], 0)
        self._logout()

        self._login("alice", "alicepassword1")
        stats = self.client.get("/api/settings/stats")
        self.assertGreaterEqual(stats.json()["total_files"], 1)
        self._logout()


if __name__ == "__main__":
    unittest.main()
