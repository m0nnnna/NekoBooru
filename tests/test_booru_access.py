import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ADMIN = {"username": "admin", "password": "correct horse battery staple"}
MEMBER = {"username": "bob", "password": "hunter2222"}


class BooruAccessTests(unittest.TestCase):
    """The booru-search permission gate: the admin-only instance switch, the
    per-user ``canBrowseBoorus`` capability on /api/auth/me, and the single
    ``booru_search_allowed`` / ``require_booru_search`` pair."""

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
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

        from fastapi.testclient import TestClient
        from app.config import settings
        from app.database import reset_engine_for_tests
        from app.main import app

        # settings.config_file is fixed by whichever test class imported
        # app.config first; point it at this class's own settings.json so the
        # switch never leaks into (or out of) another class.
        cls.config_file = tmp_root / "config" / "settings.json"
        cls.config_file.parent.mkdir(parents=True, exist_ok=True)
        cls._previous_config_file = settings.config_file
        settings.config_file = cls.config_file

        reset_engine_for_tests()

        cls.admin = TestClient(app)
        cls.admin.__enter__()
        boot = cls.admin.post("/api/auth/bootstrap-admin", json=ADMIN)
        assert boot.status_code == 200, boot.text
        login = cls.admin.post("/api/auth/login", json=ADMIN)
        assert login.status_code == 200, login.text
        created = cls.admin.post("/api/auth/users", json=MEMBER)
        assert created.status_code == 200, created.text

        cls.member = TestClient(app)
        login = cls.member.post("/api/auth/login", json=MEMBER)
        assert login.status_code == 200, login.text
        cls.anonymous = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.admin.__exit__(None, None, None)
        from app.config import settings
        from app.database import engine

        settings.config_file = cls._previous_config_file
        asyncio.run(engine.dispose())
        for key, value in cls._previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.tmp.cleanup()

    def _stored(self) -> dict:
        if not self.config_file.exists():
            return {}
        return json.loads(self.config_file.read_text(encoding="utf-8"))

    def _set_switch(self, enabled: bool):
        resp = self.admin.put("/api/settings/booru-search", json={"enabled": enabled})
        self.assertEqual(resp.status_code, 200, resp.text)

    def test_01_switch_is_off_by_default(self):
        self.assertNotIn("booruSearch", self._stored())
        resp = self.admin.get("/api/settings/booru-search")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"enabled": False})
        for client in (self.admin, self.member):
            me = client.get("/api/auth/me")
            self.assertEqual(me.status_code, 200, me.text)
            self.assertIs(me.json()["canBrowseBoorus"], False)

    def test_02_only_admins_read_or_write_the_switch(self):
        self.assertEqual(self.member.get("/api/settings/booru-search").status_code, 403)
        denied = self.member.put("/api/settings/booru-search", json={"enabled": True})
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.json()["detail"], "Admin only")
        self.assertEqual(self.anonymous.get("/api/settings/booru-search").status_code, 401)
        self.assertEqual(self.anonymous.put("/api/settings/booru-search", json={"enabled": True}).status_code, 401)
        self.assertNotIn("booruSearch", self._stored())
        self.assertEqual(self.admin.put("/api/settings/booru-search", json={}).status_code, 422)

    def test_03_admin_enables_it_for_every_user(self):
        try:
            resp = self.admin.put("/api/settings/booru-search", json={"enabled": True})
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(resp.json(), {"enabled": True})
            self.assertEqual(self._stored()["booruSearch"], {"enabled": True})
            self.assertEqual(self.admin.get("/api/settings/booru-search").json(), {"enabled": True})
            for client in (self.admin, self.member):
                self.assertIs(client.get("/api/auth/me").json()["canBrowseBoorus"], True)

            self._set_switch(False)
            self.assertEqual(self._stored()["booruSearch"], {"enabled": False})
            for client in (self.admin, self.member):
                self.assertIs(client.get("/api/auth/me").json()["canBrowseBoorus"], False)
        finally:
            self._set_switch(False)

    def test_04_other_settings_survive_the_switch(self):
        data = self._stored()
        data["extension"] = {"saveTweetTag": False}
        self.config_file.write_text(json.dumps(data), encoding="utf-8")
        try:
            self._set_switch(True)
            self.assertEqual(self._stored()["extension"], {"saveTweetTag": False})
        finally:
            self._set_switch(False)

    def test_05_permission_function_and_dependency(self):
        from fastapi import HTTPException
        from app.models import User
        from app.services import booru_access

        user = User(id=999, username="someone", password_hash="x", is_admin=False, is_active=True)
        self.assertFalse(booru_access.booru_search_allowed(user))
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(booru_access.require_booru_search(user))
        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(raised.exception.detail["code"], "booru_search_disabled")
        self.assertEqual(raised.exception.detail["message"], booru_access.DISABLED_MESSAGE)

        try:
            self._set_switch(True)
            self.assertTrue(booru_access.booru_search_allowed(user))
            self.assertIs(asyncio.run(booru_access.require_booru_search(user)), user)
        finally:
            self._set_switch(False)

    def test_06_only_true_counts_as_enabled(self):
        from app.services import booru_access

        for stored in ({"enabled": "yes"}, {"enabled": 1}, {}, None):
            data = self._stored()
            if stored is None:
                data.pop("booruSearch", None)
            else:
                data["booruSearch"] = stored
            self.config_file.write_text(json.dumps(data), encoding="utf-8")
            self.assertFalse(booru_access.booru_search_enabled(), stored)
            self.assertEqual(self.admin.get("/api/settings/booru-search").json(), {"enabled": False})


if __name__ == "__main__":
    unittest.main()
