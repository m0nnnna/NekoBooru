import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path


class AuthApiTests(unittest.TestCase):
    """Covers the Phase 1 auth foundation: bootstrap, login/logout/me, admin
    user management, sharing grants, and API tokens. Per-router content
    scoping (posts/pools/favorites private by owner) is exercised separately
    in test_post_isolation.py.

    Needs a database with zero users at the start, so it calls
    ``reset_engine_for_tests()`` in setUpClass - see that function's
    docstring in app/database.py for why every DB-backed test class needs it,
    not just this one.
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

    def _seed_preexisting_content(self):
        """Insert a post/pool/favorite/sync_log rows directly, bypassing the
        (now-authenticated) HTTP API - this simulates data that was already
        in the database from before the multi-user migration ever ran, which
        is exactly what bootstrap-admin's backfill needs to handle. Real
        pre-existing rows can no longer be produced by uploading through
        /api/posts, since that endpoint requires a logged-in user now.
        """
        import hashlib
        from app.database import async_session
        from app.models import Favorite, Pool, Post, SyncLog

        stamp = time.time_ns()
        digest = hashlib.sha256(f"pre-existing-{stamp}".encode()).hexdigest()

        async def _seed():
            async with async_session() as session:
                post = Post(sha256=digest, filename="pre-existing.png", extension=".png", file_size=1)
                session.add(post)
                await session.flush()
                session.add(Favorite(post_id=post.id))
                session.add(Pool(name="Pre-existing pool"))
                session.add(SyncLog(entity_type="post", entity_key=digest, op="upsert"))
                session.add(SyncLog(entity_type="tag", entity_key="some-preexisting-tag", op="upsert"))
                await session.commit()
                return post.id, post.sha256

        return asyncio.run(_seed())

    def _query_row(self, model_name, **filters):
        from app import models
        from app.database import async_session
        from sqlalchemy import select

        model = getattr(models, model_name)

        async def _run():
            async with async_session() as session:
                stmt = select(model)
                for key, value in filters.items():
                    stmt = stmt.where(getattr(model, key) == value)
                result = await session.execute(stmt)
                return result.scalars().first()

        return asyncio.run(_run())

    # ------------------------------------------------------------------
    # Bootstrap
    # ------------------------------------------------------------------

    def test_01_status_reports_no_users_before_bootstrap(self):
        resp = self.client.get("/api/auth/status")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["hasUsers"])

    def test_02_bootstrap_backfills_preexisting_content_to_new_admin(self):
        post_id, sha256 = self._seed_preexisting_content()

        boot = self.client.post(
            "/api/auth/bootstrap-admin", json={"username": "admin", "password": "correct horse battery staple"}
        )
        self.assertEqual(boot.status_code, 200, boot.text)
        admin = boot.json()
        self.assertTrue(admin["isAdmin"])
        self.__class__.admin_id = admin["id"]

        db_post = self._query_row("Post", id=post_id)
        self.assertEqual(db_post.owner_id, admin["id"])

        db_pool = self._query_row("Pool", name="Pre-existing pool")
        self.assertEqual(db_pool.owner_id, admin["id"])

        db_fav = self._query_row("Favorite", post_id=post_id)
        self.assertEqual(db_fav.user_id, admin["id"])

        tag_sync_row = self._query_row("SyncLog", entity_type="tag")
        self.assertIsNotNone(tag_sync_row)
        self.assertEqual(tag_sync_row.user_id, admin["id"])

        post_sync_row = self._query_row("SyncLog", entity_type="post", entity_key=sha256)
        self.assertEqual(post_sync_row.user_id, admin["id"])

    def test_03_bootstrap_fails_once_admin_exists(self):
        resp = self.client.post("/api/auth/bootstrap-admin", json={"username": "someone-else", "password": "x"})
        self.assertEqual(resp.status_code, 409)

    def test_04_admin_management_requires_authentication(self):
        self.client.cookies.clear()
        resp = self.client.post("/api/auth/users", json={"username": "bob", "password": "hunter2222"})
        self.assertEqual(resp.status_code, 401)

    # ------------------------------------------------------------------
    # Login / logout / me
    # ------------------------------------------------------------------

    def test_05_login_rejects_wrong_password(self):
        resp = self.client.post("/api/auth/login", json={"username": "admin", "password": "nope"})
        self.assertEqual(resp.status_code, 401)

    def test_06_login_success_and_me(self):
        resp = self.client.post(
            "/api/auth/login", json={"username": "admin", "password": "correct horse battery staple"}
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        me = self.client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["username"], "admin")
        self.assertTrue(me.json()["isAdmin"])

    def test_07_logout_invalidates_session(self):
        logout = self.client.post("/api/auth/logout")
        self.assertEqual(logout.status_code, 200)
        me = self.client.get("/api/auth/me")
        self.assertEqual(me.status_code, 401)

    # ------------------------------------------------------------------
    # Admin user management + non-admin restrictions
    # ------------------------------------------------------------------

    def test_08_admin_creates_second_user(self):
        login = self.client.post(
            "/api/auth/login", json={"username": "admin", "password": "correct horse battery staple"}
        )
        self.assertEqual(login.status_code, 200)
        created = self.client.post("/api/auth/users", json={"username": "bob", "password": "hunter2222"})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertFalse(created.json()["isAdmin"])
        self.client.post("/api/auth/logout")

    def test_09_non_admin_cannot_list_users(self):
        login = self.client.post("/api/auth/login", json={"username": "bob", "password": "hunter2222"})
        self.assertEqual(login.status_code, 200, login.text)
        resp = self.client.get("/api/auth/users")
        self.assertEqual(resp.status_code, 403)
        self.client.post("/api/auth/logout")

    def test_10_deactivated_user_cannot_log_in(self):
        login = self.client.post(
            "/api/auth/login", json={"username": "admin", "password": "correct horse battery staple"}
        )
        self.assertEqual(login.status_code, 200)
        users = self.client.get("/api/auth/users").json()
        bob = next(u for u in users if u["username"] == "bob")
        patched = self.client.patch(f"/api/auth/users/{bob['id']}", json={"isActive": False})
        self.assertEqual(patched.status_code, 200, patched.text)
        self.client.post("/api/auth/logout")

        blocked = self.client.post("/api/auth/login", json={"username": "bob", "password": "hunter2222"})
        self.assertEqual(blocked.status_code, 403)

        # Reactivate for the remaining tests.
        self.client.post(
            "/api/auth/login", json={"username": "admin", "password": "correct horse battery staple"}
        )
        self.client.patch(f"/api/auth/users/{bob['id']}", json={"isActive": True})
        self.client.post("/api/auth/logout")

    # ------------------------------------------------------------------
    # Sharing
    # ------------------------------------------------------------------

    def test_11_owner_can_grant_and_revoke_a_share(self):
        self.client.post(
            "/api/auth/login", json={"username": "admin", "password": "correct horse battery staple"}
        )
        put_resp = self.client.put("/api/auth/shares", json={"granteeUsernames": ["bob"]})
        self.assertEqual(put_resp.status_code, 200, put_resp.text)
        self.assertEqual(put_resp.json()["sharedByMe"], ["bob"])

        get_resp = self.client.get("/api/auth/shares")
        self.assertEqual(get_resp.json()["sharedByMe"], ["bob"])
        self.client.post("/api/auth/logout")

        self.client.post("/api/auth/login", json={"username": "bob", "password": "hunter2222"})
        bob_shares = self.client.get("/api/auth/shares")
        self.assertEqual(bob_shares.json()["sharedWithMe"], ["admin"])
        self.client.post("/api/auth/logout")

        self.client.post(
            "/api/auth/login", json={"username": "admin", "password": "correct horse battery staple"}
        )
        revoke_resp = self.client.put("/api/auth/shares", json={"granteeUsernames": []})
        self.assertEqual(revoke_resp.json()["sharedByMe"], [])
        self.client.post("/api/auth/logout")

    # ------------------------------------------------------------------
    # API tokens (bearer auth, no cookie)
    # ------------------------------------------------------------------

    def test_12_api_token_authenticates_without_a_cookie(self):
        self.client.post("/api/auth/login", json={"username": "bob", "password": "hunter2222"})
        created = self.client.post("/api/auth/tokens", json={"label": "Extension"})
        self.assertEqual(created.status_code, 200, created.text)
        raw_token = created.json()["token"]
        token_id = created.json()["id"]
        self.client.post("/api/auth/logout")

        saved_cookies = dict(self.client.cookies)
        self.client.cookies.clear()
        try:
            me = self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {raw_token}"})
            self.assertEqual(me.status_code, 200, me.text)
            self.assertEqual(me.json()["username"], "bob")

            garbage = self.client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-real-token"})
            self.assertEqual(garbage.status_code, 401)
        finally:
            self.client.cookies.clear()
            self.client.cookies.update(saved_cookies)

        self.client.post("/api/auth/login", json={"username": "bob", "password": "hunter2222"})
        self.client.delete(f"/api/auth/tokens/{token_id}")
        self.client.post("/api/auth/logout")

        saved_cookies = dict(self.client.cookies)
        self.client.cookies.clear()
        try:
            revoked = self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {raw_token}"})
            self.assertEqual(revoked.status_code, 401)
        finally:
            self.client.cookies.clear()
            self.client.cookies.update(saved_cookies)


if __name__ == "__main__":
    unittest.main()
