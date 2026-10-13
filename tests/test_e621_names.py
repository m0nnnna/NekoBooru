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


if __name__ == "__main__":
    unittest.main()
