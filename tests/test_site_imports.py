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
