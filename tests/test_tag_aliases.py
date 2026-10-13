import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


class FakeBooruClient:
    """Answers Danbooru's batched alias search and Sankaku's post search, counting calls."""

    def __init__(self, aliases, on_sankaku, throttle_sankaku=False):
        self.aliases = aliases
        self.on_sankaku = on_sankaku
        self.throttle_sankaku = throttle_sankaku
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def get(self, url, params=None):
        import httpx

        self.calls.append((url, dict(params or {})))
        request = httpx.Request("GET", url)
        if "danbooru" in url:
            asked = params["search[antecedent_name_comma]"].split(",")
            rows = [
                {"antecedent_name": short, "consequent_name": long}
                for short, long in self.aliases.items()
                if short in asked
            ]
            return httpx.Response(200, json=rows, request=request)
        if self.throttle_sankaku:
            return httpx.Response(429, json={}, request=request)
        found = [{"id": "x"}] if params["tags"] in self.on_sankaku else []
        return httpx.Response(200, json=found, request=request)


class TagAliasMergeTests(unittest.TestCase):
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
        boot = cls.client.post(
            "/api/auth/bootstrap-admin", json={"username": "test-admin", "password": "test-admin-password"}
        )
        assert boot.status_code == 200, boot.text
        cls._image_counter = 0

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

    def _post(self, tags, categories=None, source=None):
        from PIL import Image

        type(self)._image_counter += 1
        count = self._image_counter
        image_path = Path(self.tmp.name) / f"alias-{count}.png"
        Image.new("RGB", (16, 16), (count * 37 % 256, count * 91 % 256, count * 13 % 256)).save(image_path)
        with image_path.open("rb") as fh:
            upload = self.client.post("/api/uploads", files={"content": (image_path.name, fh, "image/png")})
        self.assertEqual(upload.status_code, 200, upload.text)
        created = self.client.post(
            "/api/posts",
            json={
                "contentToken": upload.json()["token"],
                "tags": tags,
                "tagCategories": categories or {},
                "source": source,
                "autoTag": False,
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        return created.json()

    def _tag(self, name):
        found = self.client.get("/api/tags", params={"q": name, "limit": 50}).json()["results"]
        return next((tag for tag in found if tag["name"] == name), None)

    def test_aliasing_an_existing_tag_merges_its_posts(self):
        sankaku = self._post(["honoka_(dead_or_alive)", "beach"], {"honoka_(dead_or_alive)": "character"})
        both = self._post(["honoka_(dead_or_alive)", "honoka_(doa)"])
        self._post(["honoka_(doa)"], {"honoka_(doa)": "character"})

        # Typed with the booru's brackets: must match the stored flattened names.
        response = self.client.post(
            "/api/tag-aliases", json={"alias": "honoka_(dead_or_alive)", "target": "honoka_(doa)"}
        )
        self.assertEqual(response.status_code, 200, response.text)
        alias = response.json()
        self.assertEqual(alias["aliasName"], "honoka_dead_or_alive")
        self.assertEqual(alias["targetName"], "honoka_doa")
        self.assertEqual(alias["mergedPosts"], 1)
        self.assertFalse(alias["renamed"])

        self.assertIsNone(self._tag("honoka_dead_or_alive"))
        self.assertEqual(self._tag("honoka_doa")["usageCount"], 3)
        for post_id in (sankaku["id"], both["id"]):
            tags = self.client.get(f"/api/posts/{post_id}").json()["tags"]
            self.assertIn("honoka_doa", tags)
            self.assertNotIn("honoka_dead_or_alive", tags)

        # Later imports under the Sankaku spelling land on the same tag.
        later = self._post(["honoka_(dead_or_alive)"])
        self.assertIn("honoka_doa", later["tags"])
        self.assertNotIn("honoka_dead_or_alive", later["tags"])

    def test_aliasing_to_a_missing_tag_renames_it(self):
        self._post(["kasumi_(dead_or_alive)"], {"kasumi_(dead_or_alive)": "character"})

        response = self.client.post(
            "/api/tag-aliases", json={"alias": "kasumi_dead_or_alive", "target": "kasumi_(doa)"}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["renamed"])
        renamed = self._tag("kasumi_doa")
        self.assertEqual(renamed["usageCount"], 1)
        self.assertEqual(renamed["category"], "character")
        self.assertEqual(renamed["displayName"], "kasumi (doa)")
        self.assertIsNone(self._tag("kasumi_dead_or_alive"))

    def test_merge_carries_implications_and_aliases_over(self):
        self._post(["ayane_(dead_or_alive)", "ayane_doa_alt", "dead_or_alive"])
        self._post(["ayane_(doa)"])
        implication = self.client.post(
            "/api/tag-implications",
            json={"antecedent": "ayane_dead_or_alive", "consequent": "dead_or_alive"},
        )
        self.assertEqual(implication.status_code, 200, implication.text)
        older = self.client.post("/api/tag-aliases", json={"alias": "ayane_doa_alt", "target": "ayane_dead_or_alive"})
        self.assertEqual(older.status_code, 200, older.text)

        merged = self.client.post("/api/tag-aliases", json={"alias": "ayane_dead_or_alive", "target": "ayane_doa"})
        self.assertEqual(merged.status_code, 200, merged.text)

        aliases = {row["aliasName"]: row["targetName"] for row in self.client.get("/api/tag-aliases").json()}
        self.assertEqual(aliases["ayane_doa_alt"], "ayane_doa")
        self.assertEqual(aliases["ayane_dead_or_alive"], "ayane_doa")
        implications = [(row["antecedent"], row["consequent"]) for row in self.client.get("/api/tag-implications").json()]
        self.assertIn(("ayane_doa", "dead_or_alive"), implications)

    def test_mapping_script_only_touches_tags_on_sankaku_posts(self):
        import sqlite3

        repo_root = str(Path(__file__).resolve().parents[1])
        if repo_root not in sys.path:
            sys.path.insert(0, repo_root)
        import map_sankaku_tags
        from app.config import settings

        self._post(
            ["hitomi_(dead_or_alive)", "dead_or_alive", "beach"],
            {"hitomi_(dead_or_alive)": "character", "dead_or_alive": "copyright"},
            source="https://chan.sankakucomplex.com/en/posts/aaa111",
        )
        self._post(["leifang_(dead_or_alive)"], {"leifang_(dead_or_alive)": "character"}, source="https://gelbooru.com/x")
        self._post(["hitomi_(doa)"], {"hitomi_(doa)": "character"})

        con = sqlite3.connect(str(settings.database_path))
        try:
            found = {tag["spelling"]: tag for tag in map_sankaku_tags.sankaku_tags(con)}
        finally:
            con.close()
        # Unqualified tags and tags only on non-Sankaku posts are left out.
        self.assertIn("hitomi_(dead_or_alive)", found)
        self.assertNotIn("leifang_(dead_or_alive)", found)
        self.assertNotIn("dead_or_alive", found)

        done = asyncio.run(map_sankaku_tags.apply_mappings([(found["hitomi_(dead_or_alive)"], "hitomi_(doa)")]))
        self.assertIn("merged 1 post(s)", done[0])
        self.assertIsNone(self._tag("hitomi_dead_or_alive"))
        merged = self._tag("hitomi_doa")
        self.assertEqual(merged["usageCount"], 2)
        self.assertEqual(merged["sankakuName"], "hitomi_(dead_or_alive)")

    def test_alias_autocomplete_can_ask_the_boorus_with_the_setting_off(self):
        from types import SimpleNamespace

        self._post(["kokoro_(doa)"])
        remote_row = {
            "name": "kokoro_dead_or_alive_xtreme",
            "displayName": "kokoro (dead or alive xtreme)",
            "category": "character",
            "remote": True,
            "source": "danbooru",
            "remoteCount": 12,
            "usageCount": 0,
        }
        options = SimpleNamespace(booruSuggestEnabled=False)
        with patch("app.services.auto_tagger.load_options", return_value=options), patch(
            "app.services.booru_suggest.suggest_tags", AsyncMock(return_value=[remote_row])
        ):
            gated = self.client.get("/api/tags/autocomplete", params={"q": "kokoro", "includeRemote": "true"}).json()
            forced = self.client.get(
                "/api/tags/autocomplete", params={"q": "kokoro", "includeRemote": "true", "forceRemote": "true"}
            ).json()
        self.assertEqual([row["name"] for row in gated], ["kokoro_doa"])
        self.assertEqual([row["name"] for row in forced], ["kokoro_doa", "kokoro_dead_or_alive_xtreme"])

    def test_alias_rejects_self_and_duplicates(self):
        self._post(["marie_rose"])
        self.assertEqual(
            self.client.post("/api/tag-aliases", json={"alias": "marie rose", "target": "marie_rose"}).status_code, 400
        )
        self.assertEqual(
            self.client.post("/api/tag-aliases", json={"alias": "no_such_tag", "target": "also_missing"}).status_code,
            404,
        )
        self._post(["marie_(doa)"])
        first = self.client.post("/api/tag-aliases", json={"alias": "marie", "target": "marie_rose"})
        self.assertEqual(first.status_code, 200, first.text)
        # Repeating the same alias is fine (imports re-send it); retargeting is not.
        self.assertEqual(
            self.client.post("/api/tag-aliases", json={"alias": "marie", "target": "marie_rose"}).status_code, 200
        )
        self.assertEqual(
            self.client.post("/api/tag-aliases", json={"alias": "marie", "target": "marie_(doa)"}).status_code, 409
        )

    def test_import_alias_records_the_sankaku_name(self):
        post = self._post(["misaki_(doa)"], {"misaki_(doa)": "character"})
        response = self.client.post(
            "/api/tag-aliases",
            json={"alias": "misaki_(dead_or_alive)", "target": "misaki_(doa)", "sankakuName": "misaki_(dead_or_alive)"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self._tag("misaki_doa")["sankakuName"], "misaki_(dead_or_alive)")
        details = self.client.get(f"/api/posts/{post['id']}").json()["tagDetails"]
        self.assertEqual(
            next(tag for tag in details if tag["name"] == "misaki_doa")["sankakuName"], "misaki_(dead_or_alive)"
        )

    def test_repeated_import_alias_fills_a_missing_sankaku_name(self):
        self._post(["tamaki_(doa)"])
        plain = self.client.post("/api/tag-aliases", json={"alias": "tamaki_(dead_or_alive)", "target": "tamaki_(doa)"})
        self.assertEqual(plain.status_code, 200, plain.text)
        self.assertIsNone(self._tag("tamaki_doa")["sankakuName"])
        again = self.client.post(
            "/api/tag-aliases",
            json={"alias": "tamaki_(dead_or_alive)", "target": "tamaki_(doa)", "sankakuName": "tamaki_(dead_or_alive)"},
        )
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(self._tag("tamaki_doa")["sankakuName"], "tamaki_(dead_or_alive)")

    def test_merging_a_tag_from_sankaku_hands_its_spelling_over(self):
        self._post(
            ["nyotengu_(dead_or_alive)"],
            {"nyotengu_(dead_or_alive)": "character"},
            source="https://chan.sankakucomplex.com/posts/abc123",
        )
        self._post(["nyotengu_(doa)"])
        merged = self.client.post("/api/tag-aliases", json={"alias": "nyotengu_dead_or_alive", "target": "nyotengu_(doa)"})
        self.assertEqual(merged.status_code, 200, merged.text)
        self.assertEqual(self._tag("nyotengu_doa")["sankakuName"], "nyotengu_(dead_or_alive)")

    def test_renaming_a_tag_from_sankaku_keeps_its_spelling(self):
        self._post(
            ["luna_(dead_or_alive)"],
            {"luna_(dead_or_alive)": "character"},
            source="https://sankaku.app/posts/def456",
        )
        renamed = self.client.post("/api/tag-aliases", json={"alias": "luna_dead_or_alive", "target": "luna_(doa)"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        tag = self._tag("luna_doa")
        self.assertEqual(tag["sankakuName"], "luna_(dead_or_alive)")
        self.assertEqual(tag["displayName"], "luna (doa)")

    def test_merging_a_tag_not_from_sankaku_records_nothing(self):
        self._post(["lisa_(dead_or_alive)"], source="https://gelbooru.com/index.php?page=post&s=view&id=1")
        self._post(["lisa_(doa)"])
        merged = self.client.post("/api/tag-aliases", json={"alias": "lisa_dead_or_alive", "target": "lisa_(doa)"})
        self.assertEqual(merged.status_code, 200, merged.text)
        self.assertIsNone(self._tag("lisa_doa")["sankakuName"])

    def test_sankaku_name_is_looked_up_once_on_demand(self):
        self._post(["momiji_(doa)"], {"momiji_(doa)": "character"})
        lookup = AsyncMock(return_value="momiji_(dead_or_alive)")
        with patch("app.services.site_imports.lookup_sankaku_name", lookup):
            first = self.client.post("/api/tags/momiji_doa/sankaku-name")
            second = self.client.post("/api/tags/momiji_doa/sankaku-name")
        self.assertEqual(first.json(), {"sankakuName": "momiji_(dead_or_alive)", "found": True})
        self.assertEqual(second.json(), {"sankakuName": "momiji_(dead_or_alive)", "found": True})
        lookup.assert_awaited_once_with("momiji_(doa)")
        self.assertEqual(self._tag("momiji_doa")["sankakuName"], "momiji_(dead_or_alive)")

    def test_sankaku_name_lookup_misses_and_failures_store_nothing(self):
        import httpx

        self._post(["sayuri_(doa)"], {"sayuri_(doa)": "character"})
        with patch("app.services.site_imports.lookup_sankaku_name", AsyncMock(return_value=None)):
            missed = self.client.post("/api/tags/sayuri_doa/sankaku-name")
        with patch(
            "app.services.site_imports.lookup_sankaku_name", AsyncMock(side_effect=httpx.ConnectError("offline"))
        ):
            failed = self.client.post("/api/tags/sayuri_doa/sankaku-name")
        self.assertEqual(missed.json(), {"sankakuName": "sayuri_(doa)", "found": False})
        self.assertEqual(failed.json(), {"sankakuName": "sayuri_(doa)", "found": False})
        self.assertIsNone(self._tag("sayuri_doa")["sankakuName"])
        self.assertEqual(self.client.post("/api/tags/no_such_tag/sankaku-name").status_code, 404)

    def test_e621_name_is_looked_up_once_on_demand(self):
        self._post(["hirasawa_yui"], {"hirasawa_yui": "character"})
        lookup = AsyncMock(return_value="yui_hirasawa")
        with patch("app.services.e621_names.lookup_e621_name", lookup):
            first = self.client.post("/api/tags/hirasawa_yui/e621-name")
            second = self.client.post("/api/tags/hirasawa_yui/e621-name")
        self.assertEqual(first.json(), {"e621Name": "yui_hirasawa", "found": True})
        self.assertEqual(second.json(), {"e621Name": "yui_hirasawa", "found": True})
        lookup.assert_awaited_once_with("hirasawa_yui")
        self.assertEqual(self._tag("hirasawa_yui")["e621Name"], "yui_hirasawa")

    def test_post_tag_details_carry_the_stored_e621_name(self):
        post = self._post(["kotobuki_tsumugi", "piano"], {"kotobuki_tsumugi": "character"})
        with patch("app.services.e621_names.lookup_e621_name", AsyncMock(return_value="tsumugi_kotobuki")):
            self.client.post("/api/tags/kotobuki_tsumugi/e621-name")

        def e621_names(details):
            return {tag["name"]: tag["e621Name"] for tag in details if tag["name"] in ("kotobuki_tsumugi", "piano")}

        detail = self.client.get(f"/api/posts/{post['id']}").json()["tagDetails"]
        self.assertEqual(e621_names(detail), {"kotobuki_tsumugi": "tsumugi_kotobuki", "piano": None})
        page = self.client.get("/api/posts", params={"q": "kotobuki_tsumugi"}).json()["results"]
        listed = next(row for row in page if row["id"] == post["id"])
        self.assertEqual(e621_names(listed["tagDetails"]), {"kotobuki_tsumugi": "tsumugi_kotobuki", "piano": None})

    def test_e621_name_lookup_misses_and_failures_store_nothing(self):
        import httpx
        from app.services.site_imports import SourceThrottled

        self._post(["akiyama_mio"], {"akiyama_mio": "character"})
        with patch("app.services.e621_names.lookup_e621_name", AsyncMock(return_value=None)):
            missed = self.client.post("/api/tags/akiyama_mio/e621-name")
        with patch("app.services.e621_names.lookup_e621_name", AsyncMock(side_effect=httpx.ConnectError("offline"))):
            failed = self.client.post("/api/tags/akiyama_mio/e621-name")
        with patch("app.services.e621_names.lookup_e621_name", AsyncMock(side_effect=SourceThrottled("429"))):
            throttled = self.client.post("/api/tags/akiyama_mio/e621-name")
        for response in (missed, failed, throttled):
            self.assertEqual(response.json(), {"e621Name": "akiyama_mio", "found": False})
        self.assertIsNone(self._tag("akiyama_mio")["e621Name"])
        self.assertEqual(self.client.post("/api/tags/no_such_tag/e621-name").status_code, 404)


class DanbooruNameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def setUp(self):
        from app.services import site_imports

        site_imports._danbooru_name_cache.clear()

    def test_sankaku_qualifier_maps_to_danbooru_abbreviation(self):
        from app.services import site_imports

        used = {"honoka_(doa)": 822, "miyu_(blue_archive)": 5000, "special_week_(umamusume)": 900}
        aliases = [("doa", "dead_or_alive"), ("uma_musume", "umamusume"), ("misaki_(dead_or_alive)", "misaki_(doa)")]

        async def fake_get(_client, path, params):
            if path == "/tags.json":
                names = params["search[name_comma]"].split(",")
                return [{"name": name, "post_count": used[name]} for name in names if name in used]
            field = next(key for key in params if key.endswith("_comma]"))
            asked = params[field].split(",")
            side = 0 if "antecedent" in field else 1
            return [
                {"antecedent_name": pair[0], "consequent_name": pair[1]} for pair in aliases if pair[side] in asked
            ]

        tags = [
            "honoka_(dead_or_alive)",
            "misaki_(dead_or_alive)",
            "special_week_(uma_musume)",
            "miyu_(blue_archive)",
            "dead_or_alive",
            "hat_(object)",
        ]
        categories = {tag: "character" for tag in tags}
        categories.update({"dead_or_alive": "copyright", "hat_(object)": "general"})
        with patch.object(site_imports, "_danbooru_get", AsyncMock(side_effect=fake_get)) as get:
            renames = asyncio.run(site_imports.danbooru_names(tags, categories))

        self.assertEqual(
            renames,
            {
                "honoka_(dead_or_alive)": "honoka_(doa)",
                "misaki_(dead_or_alive)": "misaki_(doa)",
                "special_week_(uma_musume)": "special_week_(umamusume)",
            },
        )
        # Batched: a fixed handful of requests however many tags there are.
        self.assertLessEqual(get.await_count, 5)
        # Unqualified and general tags are never looked up.
        looked_up = " ".join(str(call.args[2]) for call in get.await_args_list)
        self.assertNotIn("hat_(object)", looked_up)

    def test_sankaku_name_expands_the_danbooru_abbreviation(self):
        from app.services import site_imports

        site_imports._qualifier_expansions.clear()
        client = FakeBooruClient({"doa": "dead_or_alive"}, {"honoka_(dead_or_alive)"})
        self.assertEqual(asyncio.run(site_imports.sankaku_name_for(client, "honoka_(doa)")), "honoka_(dead_or_alive)")
        self.assertIsNone(asyncio.run(site_imports.sankaku_name_for(client, "miyu_(blue_archive)")))
        self.assertIsNone(asyncio.run(site_imports.sankaku_name_for(client, "nobody_(doa)")))
        self.assertIsNone(asyncio.run(site_imports.sankaku_name_for(client, "marie_rose")))
        # "doa" was looked up once and remembered.
        self.assertEqual(sum("danbooru" in url for url, _ in client.calls), 2)

    def test_expansions_are_fetched_in_batches(self):
        from app.services import site_imports

        site_imports._qualifier_expansions.clear()
        client = FakeBooruClient({"doa": "dead_or_alive", "kancolle": "kantai_collection"}, set())
        qualifiers = ["doa", "kancolle"] + [f"series_{n}" for n in range(120)]
        expansions = asyncio.run(site_imports.expand_qualifiers(client, qualifiers))
        self.assertEqual(expansions["doa"], ["dead_or_alive"])
        self.assertEqual(expansions["kancolle"], ["kantai_collection"])
        self.assertEqual(expansions["series_5"], [])
        self.assertEqual(len(client.calls), 3)

    def test_failed_lookup_keeps_names_and_is_not_cached(self):
        import httpx
        from app.services import site_imports

        failing = AsyncMock(side_effect=httpx.ConnectError("offline"))
        with patch.object(site_imports, "_danbooru_get", failing):
            renames = asyncio.run(
                site_imports.danbooru_names(["kasumi_(dead_or_alive)"], {"kasumi_(dead_or_alive)": "character"})
            )
        self.assertEqual(renames, {})
        self.assertNotIn("kasumi_(dead_or_alive)", site_imports._danbooru_name_cache)


if __name__ == "__main__":
    unittest.main()
