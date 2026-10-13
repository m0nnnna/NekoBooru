import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


class SiteImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def setUp(self):
        from app.services import site_imports

        site_imports._tag_category_cache.clear()

    def test_gelbooru_search_replays_the_page_and_keeps_its_order(self):
        from app.services import site_imports

        def post(post_id, tags, file_url=True):
            return {
                "id": post_id,
                "file_url": f"https://img.example/{post_id}.png" if file_url else "",
                "tags": tags,
                "rating": "general",
                "width": 100,
                "height": 200,
            }

        fetch = AsyncMock(side_effect=[
            {"post": [post(3, "templus solo"), post(1, "templus azur_lane"), post(2, "templus", file_url=False)]},
            {"post": [post(7, "templus azur_lane")]},
            {"tag": [
                {"name": "templus", "type": 1},
                {"name": "azur_lane", "type": 3},
                {"name": "solo", "type": 0},
            ]},
        ])
        with patch.object(site_imports, "gelbooru_credentials", return_value=("10", "secret")), patch.object(
            site_imports, "_fetch_json", fetch
        ):
            result = asyncio.run(site_imports.gelbooru_search_for_import("templus  rating:general", 84, [1, 7, 3, 2, 1]))

        page_call = fetch.await_args_list[0].args[0]
        self.assertEqual(page_call["tags"], "templus rating:general")
        self.assertEqual(page_call["pid"], 2)
        self.assertEqual(page_call["limit"], 42)
        self.assertEqual(page_call["api_key"], "secret")
        self.assertEqual(fetch.await_args_list[1].args[0]["id"], 7)
        self.assertEqual(len(fetch.await_args_list), 3)
        self.assertEqual([item["postId"] for item in result["posts"]], [1, 7, 3])
        self.assertEqual(result["posts"][0]["fileUrl"], "https://img.example/1.png")
        self.assertEqual(result["posts"][0]["tagCategories"]["templus"], "artist")
        self.assertEqual(result["posts"][0]["tagCategories"]["azur_lane"], "copyright")
        self.assertIn("gelbooru_7", result["posts"][1]["tags"])
        self.assertEqual([item["postId"] for item in result["missing"]], [2])

    def test_gelbooru_tag_types_are_cached_between_pages(self):
        from app.services import site_imports

        fetch = AsyncMock(side_effect=[
            {"post": [{"id": 1, "file_url": "https://img.example/1.png", "tags": "templus"}]},
            {"tag": [{"name": "templus", "type": 1}]},
            {"post": [{"id": 2, "file_url": "https://img.example/2.png", "tags": "templus"}]},
        ])
        with patch.object(site_imports, "gelbooru_credentials", return_value=("10", "secret")), patch.object(
            site_imports, "_fetch_json", fetch
        ):
            asyncio.run(site_imports.gelbooru_search_for_import("templus", 0, [1]))
            second = asyncio.run(site_imports.gelbooru_search_for_import("templus", 42, [2]))

        self.assertEqual(len(fetch.await_args_list), 3)
        self.assertEqual(second["posts"][0]["tagCategories"]["templus"], "artist")

    def test_gelbooru_search_needs_posts_and_credentials(self):
        from app.services import site_imports

        with self.assertRaises(ValueError):
            asyncio.run(site_imports.gelbooru_search_for_import("x", 0, []))
        with patch.object(site_imports, "gelbooru_credentials", return_value=None):
            with self.assertRaises(PermissionError):
                asyncio.run(site_imports.gelbooru_search_for_import("x", 0, [1]))

    def test_gelbooru_import_uses_original_file_and_categories(self):
        from app.services import site_imports

        fetch = AsyncMock(side_effect=[
            {
                "post": [{
                    "id": 123,
                    "file_url": "https://img.example/original.png",
                    "sample_url": "https://img.example/sample.jpg",
                    "tags": "asuka_soryu_langley neon_genesis_evangelion solo",
                    "rating": "explicit",
                    "source": "https://artist.example/work",
                    "width": 2400,
                    "height": 3200,
                }]
            },
            {
                "tag": [
                    {"name": "asuka_soryu_langley", "type": 4},
                    {"name": "neon_genesis_evangelion", "type": 3},
                    {"name": "solo", "type": 0},
                ]
            },
        ])
        with patch.object(site_imports, "gelbooru_credentials", return_value=("10", "secret")), patch.object(
            site_imports, "_fetch_json", fetch
        ):
            result = asyncio.run(site_imports.gelbooru_post_for_import(123))

        self.assertEqual(result["fileUrl"], "https://img.example/original.png")
        self.assertEqual(result["safety"], "unsafe")
        self.assertEqual(result["tagCategories"]["asuka_soryu_langley"], "character")
        self.assertEqual(result["tagCategories"]["neon_genesis_evangelion"], "copyright")
        self.assertIn("gelbooru_123", result["tags"])
        self.assertEqual(fetch.await_args_list[0].args[0]["user_id"], "10")
        self.assertEqual(fetch.await_args_list[0].args[0]["api_key"], "secret")

    def test_gelbooru_import_decodes_html_escaped_tags_and_source(self):
        from app.services import site_imports

        fetch = AsyncMock(side_effect=[
            {"post": [{
                "id": 5,
                "file_url": "https://img.example/5.png",
                "tags": "girls&#039;_frontline &gt;_&lt; tom_&amp;_jerry solo &gt;_&lt;",
                "rating": "general",
                "source": "https://example.com/a?x=1&amp;y=2",
            }]},
            {"tag": [
                {"name": "girls&#039;_frontline", "type": 3},
                {"name": "&gt;_&lt;", "type": 0},
                {"name": "tom_&amp;_jerry", "type": 3},
            ]},
        ])
        with patch.object(site_imports, "gelbooru_credentials", return_value=("10", "secret")), patch.object(
            site_imports, "_fetch_json", fetch
        ):
            result = asyncio.run(site_imports.gelbooru_post_for_import(5))

        self.assertEqual(result["tags"], ["girls'_frontline", ">_<", "tom_&_jerry", "solo", "gelbooru_5"])
        self.assertEqual(fetch.await_args_list[1].args[0]["names"], "girls'_frontline >_< tom_&_jerry solo")
        self.assertEqual(result["tagCategories"]["girls'_frontline"], "copyright")
        self.assertEqual(result["tagCategories"]["tom_&_jerry"], "copyright")
        self.assertEqual(result["remoteSource"], "https://example.com/a?x=1&y=2")
        # Unescaped text is left alone.
        self.assertEqual(site_imports._post_tags({"tags": "a&b c;d &unknown;"}), ["a&b", "c;d", "&unknown;"])

    def test_gelbooru_import_requires_saved_credentials(self):
        from app.services import site_imports

        with patch.object(site_imports, "gelbooru_credentials", return_value=None):
            with self.assertRaisesRegex(PermissionError, "not configured"):
                asyncio.run(site_imports.gelbooru_post_for_import(123))

    def test_fetch_uses_httpx_params_and_returns_json(self):
        from app.services import site_imports

        class FakeResponse:
            status_code = 200

            @staticmethod
            def json():
                return {"post": [{"id": 123}]}

        class FakeClient:
            def __init__(self):
                self.calls = []

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def get(self, url, *, params):
                self.calls.append((url, params))
                return FakeResponse()

        client = FakeClient()
        with patch.object(site_imports.httpx, "AsyncClient", return_value=client):
            result = asyncio.run(site_imports._fetch_json({"api_key": "secret", "id": 123}, 10.0))

        self.assertEqual(result["post"][0]["id"], 123)
        self.assertEqual(client.calls[0][0], "https://gelbooru.com/index.php")
        self.assertEqual(client.calls[0][1]["api_key"], "secret")


if __name__ == "__main__":
    unittest.main()
