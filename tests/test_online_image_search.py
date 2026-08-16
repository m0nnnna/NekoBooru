import asyncio
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


class OnlineImageSearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def test_parses_danbooru_and_gelbooru_matches(self):
        from app.services import online_image_search

        danbooru = online_image_search.parse_danbooru_matches([
            {
                "id": 42,
                "file_url": "https://cdn.example/danbooru.jpg",
                "source": "https://artist.example/work",
                "image_width": 1200,
                "image_height": 900,
                "rating": "g",
                "md5": "a" * 32,
            }
        ])
        gelbooru = online_image_search.parse_gelbooru_matches({
            "post": [
                {
                    "id": "84",
                    "file_url": "https://cdn.example/gelbooru.png",
                    "source": "https://artist.example/other",
                    "width": 800,
                    "height": 1000,
                    "rating": "safe",
                    "md5": "b" * 32,
                }
            ]
        })

        self.assertEqual(danbooru[0]["postUrl"], "https://danbooru.donmai.us/posts/42")
        self.assertEqual(danbooru[0]["width"], 1200)
        self.assertEqual(gelbooru[0]["postUrl"], "https://gelbooru.com/index.php?page=post&s=view&id=84")
        self.assertEqual(gelbooru[0]["height"], 1000)

    def test_gelbooru_exact_query_uses_saved_credentials(self):
        from app.services import online_image_search

        with patch.object(
            online_image_search,
            "gelbooru_credentials",
            return_value=("9455", "gelbooru_test_secret"),
        ):
            query = online_image_search._gelbooru_post_query("c" * 32, 10)

        self.assertEqual(query["tags"], f"md5:{'c' * 32}")
        self.assertEqual(query["user_id"], "9455")
        self.assertEqual(query["api_key"], "gelbooru_test_secret")

    def test_exact_lookup_hashes_once_and_combines_provider_results(self):
        from app.services import online_image_search

        online_image_search._cache.clear()
        data = b"nekobooru exact lookup"
        with tempfile.TemporaryDirectory() as tmp:
            file_path = Path(tmp) / "sample.png"
            file_path.write_bytes(data)
            get_json = AsyncMock(side_effect=[
                [{"id": 1, "md5": hashlib.md5(data).hexdigest()}],
                {"post": [{"id": 2, "md5": hashlib.md5(data).hexdigest()}]},
            ])
            with patch.object(online_image_search, "_get_json", get_json):
                result = asyncio.run(online_image_search.find_exact_online_matches(file_path))

        self.assertEqual(result["md5"], hashlib.md5(data).hexdigest())
        self.assertEqual([row["provider"] for row in result["matches"]], ["danbooru", "gelbooru"])
        self.assertEqual([row["count"] for row in result["providers"]], [1, 1])
        self.assertEqual(get_json.await_count, 2)

    def test_answered_exact_lookup_is_cached(self):
        from app.services import online_image_search

        online_image_search._cache.clear()
        with tempfile.TemporaryDirectory() as tmp:
            file_path = Path(tmp) / "sample.png"
            file_path.write_bytes(b"cached exact lookup")
            get_json = AsyncMock(side_effect=[[{"id": 1}], {"post": []}])
            with patch.object(online_image_search, "_get_json", get_json):
                first = asyncio.run(online_image_search.find_exact_online_matches(file_path))
                second = asyncio.run(online_image_search.find_exact_online_matches(file_path))

        self.assertIs(first, second)
        self.assertEqual(get_json.await_count, 2)


if __name__ == "__main__":
    unittest.main()
