import asyncio
import hashlib
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

ADMIN = {"username": "admin", "password": "correct horse battery staple"}
MEMBER = {"username": "bob", "password": "hunter2222"}
CREDENTIALS = ("10", "secret-key")


class FakeResponse:
    def __init__(self, status_code=200, payload=None, *, body=None, headers=None):
        import json

        self.status_code = status_code
        self.headers = {key.lower(): value for key, value in (headers or {}).items()}
        self.content = body if body is not None else json.dumps(payload).encode()

    def json(self):
        import json

        return json.loads(self.content)


class FakeClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []
        self.headers = None

    def __call__(self, *, headers, timeout, follow_redirects):
        self.headers = headers
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def get(self, url, *, params):
        self.calls.append((url, params))
        if self.error:
            raise self.error
        return self.response


class BooruSearchTests(unittest.TestCase):
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

        # Own settings.json: the switch must never leak into another class.
        config_file = tmp_root / "config" / "settings.json"
        config_file.parent.mkdir(parents=True, exist_ok=True)
        cls._previous_config_file = settings.config_file
        settings.config_file = config_file

        reset_engine_for_tests()

        cls.admin = TestClient(app)
        cls.admin.__enter__()
        assert cls.admin.post("/api/auth/bootstrap-admin", json=ADMIN).status_code == 200
        assert cls.admin.post("/api/auth/login", json=ADMIN).status_code == 200
        created = cls.admin.post("/api/auth/users", json=MEMBER)
        assert created.status_code == 200, created.text
        cls.member = TestClient(app)
        assert cls.member.post("/api/auth/login", json=MEMBER).status_code == 200
        me = cls.admin.get("/api/auth/me").json()
        cls.admin_id = me["id"]
        cls.member_id = created.json()["id"]
        cls.posts = cls._seed_library()

    @classmethod
    def tearDownClass(cls):
        cls.admin.put("/api/settings/booru-search", json={"enabled": False})
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

    @classmethod
    def _seed_library(cls) -> dict:
        from app.database import async_session
        from app.models import Post, Tag
        from app.models.post import PostTag

        rows = [
            ("a_danbooru", cls.admin_id, ["danbooru_1"], False),
            ("a_danbooru_copy", cls.admin_id, ["danbooru_1"], False),
            ("a_sankaku_deleted", cls.admin_id, ["sankaku_abc"], True),
            ("a_sankaku_mixed", cls.admin_id, ["sankaku_zjrmd0qxwad"], False),
            ("b_e621", cls.member_id, ["e621_5"], False),
        ]

        async def _seed():
            ids = {}
            async with async_session() as session:
                tags = {}
                for label, owner_id, tag_names, deleted in rows:
                    digest = hashlib.sha256(f"{label}-{time.time_ns()}".encode()).hexdigest()
                    post = Post(
                        sha256=digest,
                        filename=f"{label}.png",
                        extension=".png",
                        file_size=1,
                        owner_id=owner_id,
                        deleted_at=datetime.utcnow() if deleted else None,
                    )
                    session.add(post)
                    await session.flush()
                    ids[label] = post.id
                    for name in tag_names:
                        tag = tags.get((owner_id, name))
                        if tag is None:
                            tag = Tag(name=name, owner_id=owner_id)
                            session.add(tag)
                            await session.flush()
                            tags[(owner_id, name)] = tag
                        await session.execute(PostTag.insert().values(post_id=post.id, tag_id=tag.id))
                await session.commit()
            return ids

        return asyncio.run(_seed())

    def setUp(self):
        from app.services import booru_search, site_imports

        site_imports._tag_category_cache.clear()
        booru_search._safebooru_count_cache.clear()
        self._switch(True)

    def _switch(self, enabled: bool):
        resp = self.admin.put("/api/settings/booru-search", json={"enabled": enabled})
        self.assertEqual(resp.status_code, 200, resp.text)

    def _assert_coded(self, resp, status, code):
        self.assertEqual(resp.status_code, status, resp.text)
        self.assertEqual(resp.json()["detail"]["code"], code)

    # ------------------------------------------------------------------
    # Gate
    # ------------------------------------------------------------------

    def test_gate_blocks_every_route_but_status(self):
        self._switch(False)
        fetch = AsyncMock(return_value={"post": []})
        with patch("app.services.booru_search._fetch_json", fetch):
            for client in (self.admin, self.member):
                self._assert_coded(client.get("/api/booru-search/gelbooru?tags=x"), 403, "booru_search_disabled")
                self._assert_coded(client.get("/api/booru-search/safebooru"), 403, "booru_search_disabled")
                self._assert_coded(
                    client.post("/api/booru-search/in-library", json={"keys": ["danbooru:1"]}),
                    403,
                    "booru_search_disabled",
                )
                self._assert_coded(
                    client.post("/api/booru-search/gelbooru-categories", json={"tags": ["solo"]}),
                    403,
                    "booru_search_disabled",
                )
                status = client.get("/api/booru-search/status")
                self.assertEqual(status.status_code, 200)
                self.assertIs(status.json()["enabled"], False)
        fetch.assert_not_awaited()

    def test_status_reports_capability_and_gelbooru_key(self):
        from app.services import booru_search

        with patch.object(booru_search, "gelbooru_credentials", return_value=CREDENTIALS):
            body = self.member.get("/api/booru-search/status").json()
        self.assertEqual(body, {
            "enabled": True,
            "gelbooruConfigured": True,
            "sources": ["danbooru", "e621", "sankaku", "gelbooru", "safebooru"],
        })
        with patch.object(booru_search, "gelbooru_credentials", return_value=None):
            self.assertIs(self.member.get("/api/booru-search/status").json()["gelbooruConfigured"], False)

    def test_routes_need_a_login(self):
        from fastapi.testclient import TestClient
        from app.main import app

        anonymous = TestClient(app)
        self.assertEqual(anonymous.get("/api/booru-search/status").status_code, 401)
        self.assertEqual(anonymous.get("/api/booru-search/gelbooru").status_code, 401)

    # ------------------------------------------------------------------
    # Relays
    # ------------------------------------------------------------------

    def test_gelbooru_relay_passes_params_and_raw_rows(self):
        from app.services import booru_search

        rows = [{"id": 3, "tags": "cat_ears solo", "file_url": "https://img3.gelbooru.com/3.png"}, {"id": 2}]
        fetch = AsyncMock(return_value={"@attributes": {"limit": 42, "offset": 84, "count": 12345}, "post": rows})
        with patch.object(booru_search, "gelbooru_credentials", return_value=CREDENTIALS), patch.object(
            booru_search, "_fetch_json", fetch
        ):
            resp = self.member.get(
                "/api/booru-search/gelbooru",
                params={"page": 3, "limit": 42, "tags": " cat_ears   rating:general "},
            )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"site": "gelbooru", "page": 3, "limit": 42, "total": 12345, "posts": rows})
        params = fetch.await_args.args[0]
        self.assertEqual(params["pid"], 2)
        self.assertEqual(params["limit"], 42)
        self.assertEqual(params["tags"], "cat_ears rating:general")
        self.assertEqual((params["page"], params["s"], params["q"], params["json"]), ("dapi", "post", "index", 1))
        self.assertEqual((params["user_id"], params["api_key"]), CREDENTIALS)
        self.assertEqual(fetch.await_args.kwargs["site"], "gelbooru")
        self.assertNotIn("secret-key", resp.text)

    def test_gelbooru_relay_single_post_and_empty_pages(self):
        from app.services import booru_search

        with patch.object(booru_search, "gelbooru_credentials", return_value=CREDENTIALS):
            with patch.object(booru_search, "_fetch_json", AsyncMock(return_value={"post": {"id": 9}})):
                single = self.member.get("/api/booru-search/gelbooru").json()
            with patch.object(booru_search, "_fetch_json", AsyncMock(return_value={"@attributes": {"count": 0}})):
                empty = self.member.get("/api/booru-search/gelbooru").json()
        self.assertEqual(single["posts"], [{"id": 9}])
        self.assertIsNone(single["total"])
        self.assertEqual((single["page"], single["limit"]), (1, 42))
        self.assertEqual(empty["posts"], [])
        self.assertEqual(empty["total"], 0)

    def test_gelbooru_relay_errors(self):
        from app.services import booru_search

        fetch = AsyncMock(return_value={"post": []})
        with patch.object(booru_search, "gelbooru_credentials", return_value=None), patch.object(
            booru_search, "_fetch_json", fetch
        ):
            resp = self.member.get("/api/booru-search/gelbooru?tags=x")
        self._assert_coded(resp, 400, "gelbooru_credentials_missing")
        self.assertIn("Settings", resp.json()["detail"]["message"])
        fetch.assert_not_awaited()

        cases = [
            (PermissionError("Gelbooru rejected the saved API credentials"), 400, "gelbooru_credentials_missing"),
            (booru_search.UpstreamThrottled("Gelbooru is rate limiting requests (HTTP 429)", 12.2), 429, "upstream_throttled"),
            (booru_search.UpstreamThrottled("Gelbooru is rate limiting requests (HTTP 503)"), 429, "upstream_throttled"),
            (booru_search.UpstreamError("Gelbooru returned HTTP 500", 500), 502, "upstream_error"),
        ]
        responses = []
        with patch.object(booru_search, "gelbooru_credentials", return_value=CREDENTIALS):
            for error, status, code in cases:
                with patch.object(booru_search, "_fetch_json", AsyncMock(side_effect=error)):
                    resp = self.member.get("/api/booru-search/gelbooru?tags=x")
                self._assert_coded(resp, status, code)
                responses.append(resp)
        self.assertEqual(responses[0].json()["detail"]["message"], "Gelbooru rejected the saved API credentials")
        self.assertEqual(responses[1].headers["retry-after"], "13")
        self.assertEqual(responses[1].json()["detail"]["retryAfter"], 13)
        self.assertEqual(responses[2].headers["retry-after"], "60")
        self.assertIn("HTTP 500", responses[3].json()["detail"]["message"])

    def test_relay_rejects_bad_parameters(self):
        from app.services import booru_search

        fetch = AsyncMock(return_value=[])
        with patch.object(booru_search, "gelbooru_credentials", return_value=CREDENTIALS), patch.object(
            booru_search, "_fetch_json", fetch
        ), patch.object(booru_search, "_safebooru_total", AsyncMock(return_value=None)):
            for query in ("page=0", "page=501", "limit=0", "limit=101", f"tags={'a' * 501}"):
                for site in ("gelbooru", "safebooru"):
                    resp = self.member.get(f"/api/booru-search/{site}?{query}")
                    self.assertEqual(resp.status_code, 400, (site, query, resp.text))
                    self.assertIsInstance(resp.json()["detail"], str)
            ok = self.member.get("/api/booru-search/safebooru", params={"page": 500, "limit": 100})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(fetch.await_count, 1)

    def test_safebooru_relay_passes_bare_arrays(self):
        from app.services import booru_search

        rows = [{"id": 7, "hash": "abc", "tags": "1girl solo"}]
        fetch = AsyncMock(return_value=rows)
        count = patch.object(booru_search, "_safebooru_total", AsyncMock(return_value=None))
        count.start()
        self.addCleanup(count.stop)
        with patch.object(booru_search, "_fetch_json", fetch):
            resp = self.member.get("/api/booru-search/safebooru", params={"tags": "1girl  solo", "page": 2, "limit": 42})
        self.assertEqual(resp.json(), {"site": "safebooru", "page": 2, "limit": 42, "total": None, "posts": rows})
        params = fetch.await_args.args[0]
        self.assertEqual((params["tags"], params["pid"], params["limit"]), ("1girl solo", 1, 42))
        self.assertNotIn("api_key", params)
        self.assertNotIn("user_id", params)
        self.assertEqual(fetch.await_args.kwargs["site"], "safebooru")

        for payload in ({"post": rows}, None, "nothing"):
            fetch = AsyncMock(return_value=payload)
            with patch.object(booru_search, "_fetch_json", fetch):
                body = self.member.get("/api/booru-search/safebooru").json()
            self.assertEqual(body["posts"], [])
            # Both dapi sites default to their own 42-post page.
            self.assertEqual((body["page"], body["limit"]), (1, 42))
            self.assertEqual((fetch.await_args.args[0]["pid"], fetch.await_args.args[0]["limit"]), (0, 42))

    def test_safebooru_total_comes_from_the_cached_xml_count(self):
        from app.services import booru_search

        xml = b'<?xml version="1.0" encoding="UTF-8"?><posts count="8243" offset="0"></posts>'
        client = FakeClient(FakeResponse(200, body=xml))
        page = AsyncMock(return_value=[{"id": 1}])
        with patch.object(booru_search, "_fetch_json", page), patch.object(booru_search.httpx, "AsyncClient", client):
            first = self.member.get("/api/booru-search/safebooru", params={"tags": " cat_ears  solo "}).json()
            second = self.member.get("/api/booru-search/safebooru", params={"tags": "cat_ears solo", "page": 2}).json()
            self.assertEqual((first["total"], second["total"]), (8243, 8243))
            self.assertEqual(len(client.calls), 1)  # paging reuses the cached count
            url, params = client.calls[0]
            self.assertEqual(url, "https://safebooru.org/index.php")
            self.assertEqual(params, {"page": "dapi", "s": "post", "q": "index", "tags": "cat_ears solo", "limit": 0})
            self.assertEqual(client.headers["User-Agent"], "NekoBooru/1.0 (booru search relay)")

            self.member.get("/api/booru-search/safebooru", params={"tags": "dog"})
            self.assertEqual(len(client.calls), 2)  # cached per tag string
            stamp, total = booru_search._safebooru_count_cache["cat_ears solo"]
            booru_search._safebooru_count_cache["cat_ears solo"] = (stamp - booru_search.SAFEBOORU_COUNT_TTL, total)
            self.member.get("/api/booru-search/safebooru", params={"tags": "cat_ears solo"})
            self.assertEqual(len(client.calls), 3)  # expired after ten minutes

    def test_safebooru_count_failure_leaves_total_null(self):
        import httpx
        from app.services import booru_search

        page = AsyncMock(return_value=[{"id": 1}])
        failures = [
            FakeClient(FakeResponse(429, {}, headers={"Retry-After": "5"})),
            FakeClient(FakeResponse(503, {})),
            FakeClient(FakeResponse(500, {})),
            FakeClient(error=httpx.ConnectError("down")),
            FakeClient(FakeResponse(200, body=b"<html>not xml</html>")),
            FakeClient(FakeResponse(200, body=b"")),
        ]
        for client in failures:
            with patch.object(booru_search, "_fetch_json", page), patch.object(booru_search.httpx, "AsyncClient", client):
                resp = self.member.get("/api/booru-search/safebooru", params={"tags": "solo"})
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(resp.json()["total"], None)
            self.assertEqual(resp.json()["posts"], [{"id": 1}])
            self.assertEqual(len(client.calls), 1)
        self.assertEqual(booru_search._safebooru_count_cache, {})  # failures are not remembered

        # A failed page never asks for the count.
        count = AsyncMock(return_value=5)
        throttled = AsyncMock(side_effect=booru_search.UpstreamThrottled("Safebooru is rate limiting requests (HTTP 429)"))
        with patch.object(booru_search, "_fetch_json", throttled), patch.object(booru_search, "_safebooru_total", count):
            resp = self.member.get("/api/booru-search/safebooru", params={"tags": "solo"})
        self._assert_coded(resp, 429, "upstream_throttled")
        count.assert_not_awaited()

    def test_fetch_maps_upstream_answers(self):
        import httpx
        from app.services import booru_search

        def fetch(response=None, *, site="gelbooru", error=None):
            client = FakeClient(response, error)
            with patch.object(booru_search.httpx, "AsyncClient", client):
                result = asyncio.run(booru_search._fetch_json({"api_key": "secret", "tags": "x"}, 10.0, site=site))
            return result, client

        result, client = fetch(FakeResponse(200, {"post": [{"id": 1}]}))
        self.assertEqual(result["post"][0]["id"], 1)
        self.assertEqual(client.calls[0], ("https://gelbooru.com/index.php", {"api_key": "secret", "tags": "x"}))
        self.assertEqual(client.headers["User-Agent"], "NekoBooru/1.0 (booru search relay)")

        result, client = fetch(FakeResponse(200, [{"id": 2}]), site="safebooru")
        self.assertEqual(result, [{"id": 2}])
        self.assertEqual(client.calls[0][0], "https://safebooru.org/index.php")
        self.assertIsNone(fetch(FakeResponse(200, body=b"  "), site="safebooru")[0])

        with self.assertRaises(PermissionError):
            fetch(FakeResponse(401, {}))
        with self.assertRaises(booru_search.UpstreamError) as raised:
            fetch(FakeResponse(403, {}), site="safebooru")
        self.assertEqual(raised.exception.status, 403)
        with self.assertRaises(booru_search.UpstreamThrottled) as raised:
            fetch(FakeResponse(429, {}, headers={"Retry-After": "30"}))
        self.assertEqual(raised.exception.retry_after, 30.0)
        with self.assertRaises(booru_search.UpstreamThrottled) as raised:
            fetch(FakeResponse(503, {}))
        self.assertIsNone(raised.exception.retry_after)
        with self.assertRaises(booru_search.UpstreamError) as raised:
            fetch(FakeResponse(500, {}))
        self.assertEqual(raised.exception.status, 500)
        self.assertIn("HTTP 500", str(raised.exception))
        with self.assertRaises(booru_search.UpstreamError) as raised:
            fetch(FakeResponse(200, body=b"<html>"))
        self.assertIn("HTTP 200", str(raised.exception))
        with self.assertRaises(booru_search.UpstreamError) as raised:
            fetch(error=httpx.ConnectError("down"))
        self.assertIsNone(raised.exception.status)

    def test_retry_after_parsing(self):
        from email.utils import formatdate
        from app.services import booru_search

        self.assertEqual(booru_search._retry_after("7"), 7.0)
        self.assertIsNone(booru_search._retry_after(None))
        self.assertIsNone(booru_search._retry_after("soon"))
        self.assertIsNone(booru_search._retry_after("nan"))
        later = booru_search._retry_after(formatdate(time.time() + 120, usegmt=True))
        self.assertTrue(100 <= later <= 121, later)
        self.assertEqual(booru_search._retry_after(formatdate(time.time() - 120, usegmt=True)), 0.0)

    # ------------------------------------------------------------------
    # In-library lookup
    # ------------------------------------------------------------------

    def test_parse_key(self):
        from app.services.booru_search import parse_key

        self.assertEqual(parse_key("danbooru:123"), ("danbooru", "123"))
        self.assertEqual(parse_key("Sankaku:zjrmd0QxWaD"), ("sankaku", "zjrmd0QxWaD"))
        for bad in ("bogus", "danbooru:", "danbooru:zzz", "pixiv:1", "nekobooru:4", ":1", "sankaku:a b", "e621:1:2"):
            self.assertIsNone(parse_key(bad), bad)

    def test_in_library_lookup_scopes_to_visible_live_posts(self):
        keys = ["danbooru:1", "sankaku:abc", "e621:5", "bogus", "danbooru:zzz", "sankaku:zjrmd0QxWaD"]
        resp = self.admin.post("/api/booru-search/in-library", json={"keys": keys})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"found": {
            "danbooru:1": {"postId": self.posts["a_danbooru"]},
            "sankaku:zjrmd0QxWaD": {"postId": self.posts["a_sankaku_mixed"]},
        }})

        member_view = self.member.post("/api/booru-search/in-library", json={"keys": keys}).json()
        self.assertEqual(member_view, {"found": {"e621:5": {"postId": self.posts["b_e621"]}}})

        shared = self.member.put("/api/auth/shares", json={"granteeUsernames": ["admin"]})
        self.assertEqual(shared.status_code, 200, shared.text)
        try:
            found = self.admin.post("/api/booru-search/in-library", json={"keys": keys}).json()["found"]
            self.assertEqual(found["e621:5"], {"postId": self.posts["b_e621"]})
            self.assertIn("danbooru:1", found)
            self.assertNotIn("sankaku:abc", found)
        finally:
            self.member.put("/api/auth/shares", json={"granteeUsernames": []})

    def test_in_library_lookup_limits(self):
        empty = self.admin.post("/api/booru-search/in-library", json={"keys": []})
        self.assertEqual(empty.status_code, 400)
        self.assertEqual(self.admin.post("/api/booru-search/in-library", json={}).status_code, 400)
        too_many = self.admin.post("/api/booru-search/in-library", json={"keys": [f"danbooru:{i}" for i in range(501)]})
        self.assertEqual(too_many.status_code, 400)
        self.assertIsInstance(too_many.json()["detail"], str)
        many = self.admin.post("/api/booru-search/in-library", json={"keys": [f"danbooru:{i}" for i in range(500)]})
        self.assertEqual(many.status_code, 200)
        self.assertEqual(list(many.json()["found"]), ["danbooru:1"])
        nothing_valid = self.admin.post("/api/booru-search/in-library", json={"keys": ["bogus"]})
        self.assertEqual(nothing_valid.json(), {"found": {}})

    # ------------------------------------------------------------------
    # Gelbooru categories
    # ------------------------------------------------------------------

    def test_gelbooru_categories_delegate_to_the_cached_resolver(self):
        from app.services import booru_search, site_imports

        resolved = {"templus": "artist", "azur_lane": "copyright", "solo": "general"}
        resolver = AsyncMock(return_value=resolved)
        with patch.object(booru_search, "gelbooru_credentials", return_value=CREDENTIALS), patch.object(
            site_imports, "_tag_categories", resolver
        ):
            resp = self.member.post(
                "/api/booru-search/gelbooru-categories", json={"tags": ["templus", "azur_lane", "solo", "solo", " "]}
            )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"categories": resolved})
        names, auth, timeout = resolver.await_args.args
        self.assertEqual(names, ["templus", "azur_lane", "solo"])
        self.assertEqual(auth, {"user_id": "10", "api_key": "secret-key"})
        self.assertEqual(timeout, booru_search.DEFAULT_TIMEOUT)

    def test_gelbooru_categories_use_the_real_batching_and_errors(self):
        from app.services import booru_search, site_imports

        fetch = AsyncMock(return_value={"tag": [{"name": "templus", "type": 1}]})
        with patch.object(booru_search, "gelbooru_credentials", return_value=CREDENTIALS), patch.object(
            site_imports, "_fetch_json", fetch
        ):
            body = self.member.post("/api/booru-search/gelbooru-categories", json={"tags": ["templus", "solo"]}).json()
        self.assertEqual(body["categories"], {"templus": "artist", "solo": "general"})
        self.assertEqual(fetch.await_args.args[0]["names"], "templus solo")

        with patch.object(booru_search, "gelbooru_credentials", return_value=None):
            missing = self.member.post("/api/booru-search/gelbooru-categories", json={"tags": ["solo"]})
        self._assert_coded(missing, 400, "gelbooru_credentials_missing")

        rejected = AsyncMock(side_effect=PermissionError("Gelbooru rejected the saved API credentials"))
        with patch.object(booru_search, "gelbooru_credentials", return_value=CREDENTIALS), patch.object(
            site_imports, "_fetch_json", rejected
        ):
            resp = self.member.post("/api/booru-search/gelbooru-categories", json={"tags": ["unseen_tag"]})
        self._assert_coded(resp, 400, "gelbooru_credentials_missing")

        self.assertEqual(self.member.post("/api/booru-search/gelbooru-categories", json={"tags": []}).status_code, 400)
        too_many = {"tags": [f"tag_{i}" for i in range(501)]}
        self.assertEqual(self.member.post("/api/booru-search/gelbooru-categories", json=too_many).status_code, 400)

    # ------------------------------------------------------------------
    # Honest User-Agent for e621 file hosts (section 2.6)
    # ------------------------------------------------------------------

    def test_e621_hosts_get_the_honest_user_agent(self):
        from app.routers import uploads_fetch as uploads

        for host in ("static1.e621.net", "static1.e926.net", "e621.net", "E926.NET", "cdn.donmai.us"):
            self.assertEqual(uploads._media_user_agent(host), uploads.HONEST_MEDIA_USER_AGENT, host)
        for host in ("pbs.twimg.com", "e621.net.evil.example", "note621.net", None):
            self.assertEqual(uploads._media_user_agent(host), uploads.BROWSER_USER_AGENT, host)
        self.assertEqual(uploads.DANBOORU_MEDIA_USER_AGENT, uploads.HONEST_MEDIA_USER_AGENT)
        self.assertEqual(uploads.HONEST_MEDIA_USER_AGENT, "NekoBooru/1.0 (original importer)")


    # ------------------------------------------------------------------
    # Gelbooru media relay (its CDN redirects any non-gelbooru.com referer)
    # ------------------------------------------------------------------

    def _media_transport(self, seen, *, status=200, body=b"jpegbytes", headers=None):
        import httpx

        def handler(request):
            seen.append(request)
            return httpx.Response(status, content=body, headers=headers or {"content-type": "image/jpeg"})

        return httpx.MockTransport(handler)

    def test_gelbooru_media_is_relayed_with_a_gelbooru_referer(self):
        from app.services import booru_search

        seen = []
        url = "https://img4.gelbooru.com/thumbnails/1b/c2/thumbnail_1bc2.jpg"
        with patch.object(booru_search, "_media_transport", self._media_transport(seen)):
            resp = self.member.get("/api/booru-search/gelbooru-media", params={"url": url})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.content, b"jpegbytes")
        self.assertEqual(resp.headers["content-type"], "image/jpeg")
        self.assertIn("max-age", resp.headers["cache-control"])
        self.assertEqual(str(seen[0].url), url)
        self.assertEqual(seen[0].headers["referer"], "https://gelbooru.com/")

    def test_gelbooru_media_passes_video_ranges_through(self):
        from app.services import booru_search

        seen = []
        transport = self._media_transport(
            seen,
            status=206,
            body=b"part",
            headers={"content-type": "video/mp4", "content-range": "bytes 0-3/100", "accept-ranges": "bytes"},
        )
        url = "https://video-cdn3.gelbooru.com/images/aa/bb/clip.mp4"
        with patch.object(booru_search, "_media_transport", transport):
            resp = self.member.get("/api/booru-search/gelbooru-media", params={"url": url}, headers={"Range": "bytes=0-3"})
        self.assertEqual(resp.status_code, 206, resp.text)
        self.assertEqual(resp.headers["content-range"], "bytes 0-3/100")
        self.assertEqual(seen[0].headers["range"], "bytes=0-3")

    def test_gelbooru_media_refuses_anything_but_gelbooru_media(self):
        from app.services import booru_search

        seen = []
        with patch.object(booru_search, "_media_transport", self._media_transport(seen)):
            for url in (
                "https://evil.example/thumbnails/a.jpg",
                "http://img4.gelbooru.com/images/a.jpg",
                "https://img4.gelbooru.com/index.php?page=dapi",
                "https://gelbooru.com/images/a.jpg",
                "https://img4.gelbooru.com.evil.example/images/a.jpg",
                "https://img4.gelbooru.com/images/../index.php",
            ):
                self._assert_coded(self.member.get("/api/booru-search/gelbooru-media", params={"url": url}), 400, "bad_media_url")
        self.assertEqual(seen, [])

    def test_gelbooru_media_is_gated(self):
        self._switch(False)
        url = "https://img4.gelbooru.com/thumbnails/a.jpg"
        self._assert_coded(self.member.get("/api/booru-search/gelbooru-media", params={"url": url}), 403, "booru_search_disabled")

if __name__ == "__main__":
    unittest.main()
