import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

BACKEND = str(Path(__file__).resolve().parents[1] / "backend")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)


class SwappedNameTests(unittest.TestCase):
    def test_two_part_names_swap_and_keep_the_qualifier(self):
        from app.services.e621_names import swapped_name

        self.assertEqual(swapped_name("hirasawa_yui"), "yui_hirasawa")
        self.assertEqual(swapped_name("yui_hirasawa_(k-on!)"), "hirasawa_yui_(k-on!)")
        self.assertIsNone(swapped_name("marie_rose_kun"))
        self.assertIsNone(swapped_name("saber"))
        self.assertIsNone(swapped_name("honoka_(doa)"))


def _fake_danbooru(used, aliases=()):
    async def fake_get(_client, path, params):
        if path == "/tags.json":
            names = params["search[name_comma]"].split(",")
            return [{"name": name, "post_count": used[name]} for name in names if name in used]
        field = next(key for key in params if key.endswith("_comma]"))
        asked = params[field].split(",")
        side = 0 if "antecedent" in field else 1
        return [{"antecedent_name": a, "consequent_name": c} for a, c in aliases if (a, c)[side] in asked]

    return fake_get


class DanbooruSwapTests(unittest.TestCase):
    def setUp(self):
        from app.services import site_imports

        site_imports._danbooru_name_cache.clear()

    def test_unqualified_character_from_e621_maps_to_danbooru_order(self):
        from app.services import site_imports

        fake = _fake_danbooru({"hirasawa_yui": 9000})
        with patch.object(site_imports, "_danbooru_get", AsyncMock(side_effect=fake)):
            renames = asyncio.run(site_imports.danbooru_names(["yui_hirasawa"], {"yui_hirasawa": "character"}))
        self.assertEqual(renames, {"yui_hirasawa": "hirasawa_yui"})

    def test_swap_is_kept_only_when_danbooru_uses_it(self):
        from app.services import site_imports

        fake = _fake_danbooru({})
        with patch.object(site_imports, "_danbooru_get", AsyncMock(side_effect=fake)):
            renames = asyncio.run(site_imports.danbooru_names(["yui_hirasawa"], {"yui_hirasawa": "character"}))
        self.assertEqual(renames, {})

    def test_swap_keeps_the_qualifier_and_unqualified_copyright_is_skipped(self):
        from app.services import site_imports

        fake = AsyncMock(side_effect=_fake_danbooru({"kasumi_yoshizawa_(persona)": 50}))
        tags = ["yoshizawa_kasumi_(persona)", "big_series"]
        categories = {"yoshizawa_kasumi_(persona)": "character", "big_series": "copyright"}
        with patch.object(site_imports, "_danbooru_get", fake):
            renames = asyncio.run(site_imports.danbooru_names(tags, categories))
        self.assertEqual(renames, {"yoshizawa_kasumi_(persona)": "kasumi_yoshizawa_(persona)"})
        self.assertNotIn("big_series", " ".join(str(call.args[2]) for call in fake.await_args_list))

    def test_danbooru_alias_beats_the_swap(self):
        from app.services import site_imports

        fake = _fake_danbooru({"hirasawa_yui": 9000, "yui_(k-on!)": 10}, [("yui_hirasawa", "yui_(k-on!)")])
        with patch.object(site_imports, "_danbooru_get", AsyncMock(side_effect=fake)):
            renames = asyncio.run(site_imports.danbooru_names(["yui_hirasawa"], {"yui_hirasawa": "character"}))
        self.assertEqual(renames, {"yui_hirasawa": "yui_(k-on!)"})


class FakeE621Client:
    """Answers e621's tags.json and tag_aliases.json, plus Danbooru's alias search."""

    def __init__(self, counts, aliases=None, expansions=None, status=200):
        self.counts = counts
        self.aliases = aliases or {}
        self.expansions = expansions or {}
        self.status = status
        self.calls = []

    async def get(self, url, params=None):
        import httpx

        params = dict(params or {})
        self.calls.append((url, params))
        request = httpx.Request("GET", url)
        if "danbooru" in url:
            asked = params["search[antecedent_name_comma]"].split(",")
            rows = [{"antecedent_name": a, "consequent_name": c} for a, c in self.expansions.items() if a in asked]
            return httpx.Response(200, json=rows, request=request)
        if self.status != 200:
            return httpx.Response(self.status, json={}, request=request)
        if url.endswith("/tag_aliases.json"):
            name = params["search[antecedent_name]"]
            if name in self.aliases:
                row = {"antecedent_name": name, "consequent_name": self.aliases[name]}
                return httpx.Response(200, json=[row], request=request)
            return httpx.Response(200, json={"tag_aliases": []}, request=request)
        names = params["search[name]"].split(",")
        rows = [{"name": name, "post_count": self.counts[name]} for name in names if name in self.counts]
        return httpx.Response(200, json=rows or {"tags": []}, request=request)


class E621NameTests(unittest.TestCase):
    def setUp(self):
        from app.services import site_imports

        site_imports._qualifier_expansions.clear()

    def _resolve(self, client, spelling):
        from app.services.e621_names import e621_name_for

        return asyncio.run(e621_name_for(client, spelling))

    def test_swapped_order_wins_when_e621_uses_it(self):
        client = FakeE621Client({"yui_hirasawa": 4000})
        self.assertEqual(self._resolve(client, "hirasawa_yui"), "yui_hirasawa")
        # Every candidate's post count comes from one tags.json request.
        self.assertEqual(sum(url.endswith("/tags.json") for url, _ in client.calls), 1)

    def test_highest_post_count_wins_and_the_spelling_itself_is_no_rename(self):
        client = FakeE621Client({"hirasawa_yui": 3, "yui_hirasawa": 4000})
        self.assertEqual(self._resolve(client, "hirasawa_yui"), "yui_hirasawa")
        client = FakeE621Client({"hirasawa_yui": 5000, "yui_hirasawa": 40})
        self.assertIsNone(self._resolve(client, "hirasawa_yui"))

    def test_e621_alias_and_qualifier_expansions_are_candidates(self):
        client = FakeE621Client(
            {"mio_akiyama": 10, "akiyama_mio_(k-on!)": 0}, aliases={"akiyama_mio_(k-on!)": "mio_akiyama"}
        )
        self.assertEqual(self._resolve(client, "akiyama_mio_(k-on!)"), "mio_akiyama")
        client = FakeE621Client({"honoka_(dead_or_alive)": 900}, expansions={"doa": "dead_or_alive"})
        self.assertEqual(self._resolve(client, "honoka_(doa)"), "honoka_(dead_or_alive)")
        client = FakeE621Client({"kasumi_yoshizawa_(persona_5)": 70}, expansions={"p5": "persona_5"})
        self.assertEqual(self._resolve(client, "yoshizawa_kasumi_(p5)"), "kasumi_yoshizawa_(persona_5)")

    def test_a_miss_is_none_and_throttling_raises(self):
        from app.services.site_imports import SourceThrottled

        self.assertIsNone(self._resolve(FakeE621Client({}), "hirasawa_yui"))
        with self.assertRaises(SourceThrottled):
            self._resolve(FakeE621Client({}, status=429), "hirasawa_yui")

    def test_lookup_identifies_itself_honestly(self):
        from app.services import e621_names

        self.assertTrue(e621_names.E621_USER_AGENT.startswith("NekoBooru/"))
        self.assertNotIn("Mozilla", e621_names.E621_USER_AGENT)


if __name__ == "__main__":
    unittest.main()
