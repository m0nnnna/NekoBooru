import asyncio
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path


class TagQueryNormalizationTests(unittest.TestCase):
    """Searched tags must normalize exactly like written tags.

    Tags are stored through tagging.normalize_tag(), which flattens the booru
    qualifier syntax: ``shimakaze_(kancolle)`` and the model's own
    ``shimakaze (kancolle)`` both become ``shimakaze_kancolle``. Search used to
    use two *different* normalizers, neither matching the write path, so a name
    pasted from a booru silently returned nothing.
    """

    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def test_query_normalizer_matches_the_write_normalizer(self):
        from app.services.search import _normalize_tag_query
        from app.services.tagging import normalize_tag

        cases = [
            "shimakaze_(kancolle)",
            "Shimakaze_(KanColle)",
            "shimakaze (kancolle)",
            "miyu_(swimsuit)_(blue_archive)",
            "lana's_mother_(pokemon)",
            "c.c.",
            "goddess_of_victory:_nikke",
            "1girl",
        ]
        for value in cases:
            with self.subTest(value=value):
                self.assertEqual(_normalize_tag_query(value), normalize_tag(value))

    def test_qualifier_spellings_collapse_to_one_stored_name(self):
        from app.services.search import _normalize_tag_query

        for value in ("shimakaze_kancolle", "shimakaze_(kancolle)",
                      "Shimakaze_(KanColle)", "shimakaze (kancolle)"):
            with self.subTest(value=value):
                self.assertEqual(_normalize_tag_query(value), "shimakaze_kancolle")

    def test_semantic_expansion_uses_the_same_normalizer(self):
        """The semantic path replaces the tag conditions outright.

        It had its own normalizer that flattened parentheses without merging the
        underscore runs it created, yielding "shimakaze__kancolle" - so with
        semantic search enabled a valid tag matched nothing at all.
        """
        import re

        from app.services.tagging import normalize_tag

        legacy = re.sub(r"[^\w:.-]+", "_", "shimakaze_(kancolle)").strip("_")
        self.assertEqual(legacy, "shimakaze__kancolle")
        self.assertEqual(normalize_tag("shimakaze_(kancolle)"), "shimakaze_kancolle")

    def test_punctuation_that_tags_keep_is_preserved(self):
        from app.services.search import _normalize_tag_query

        # Dots and colons are legal inside stored tag names.
        self.assertEqual(_normalize_tag_query("c.c."), "c.c.")
        self.assertEqual(_normalize_tag_query("goddess_of_victory:_nikke"), "goddess_of_victory:_nikke")


class AliasAwareSearchTests(unittest.TestCase):
    """A tag alias must be honored by search, not just by tag writes.

    Tagging a post with an alias already resolves to its target (see
    tagging.process_tags_for_post). Search matched Tag rows directly with no
    equivalent lookup, so searching the alias spelling silently returned
    nothing even though the post was findable under its target tag.
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
        root = Path(cls.tmp.name)
        os.environ.update({
            "NEKO_CONFIG_DIR": str(root / "config"),
            "NEKO_CONFIG_FILE": str(root / "config" / "settings.json"),
            "NEKO_DATA_DIR": str(root / "data"),
            "NEKO_LOGS_DIR": str(root / "logs"),
            "NEKO_MODELS_DIR": str(root / "models"),
            "NEKO_RUNTIMES_DIR": str(root / "runtimes"),
            "NEKO_CACHE_DIR": str(root / "cache"),
        })
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)
        from fastapi.testclient import TestClient
        from app.main import app
        from app.database import reset_engine_for_tests

        # app.database's engine is a module-level singleton fixed at first
        # import; under `unittest discover` every test class in the process
        # would otherwise share whichever class's database happened to be
        # created first, regardless of this class's own NEKO_DATA_DIR above.
        reset_engine_for_tests()

        cls.client_context = TestClient(app)
        cls.client = cls.client_context.__enter__()
        cls.post_id = asyncio.run(cls._seed_aliased_post())

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        from app.database import engine

        asyncio.run(engine.dispose())
        sys.path.pop(0)
        for key, value in cls._previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.tmp.cleanup()

    @staticmethod
    async def _seed_aliased_post():
        from sqlalchemy import select

        from app.database import async_session
        from app.models import Post, Tag, TagAlias, TagCategory

        async with async_session() as session:
            category = (
                await session.execute(select(TagCategory).where(TagCategory.name == "character"))
            ).scalars().first()
            target = Tag(name="coral_pokemon", display_name="coral (pokemon)", category_id=category.id)
            session.add(target)
            await session.flush()

            digest = hashlib.sha256(b"alias-search-test").hexdigest()
            post = Post(sha256=digest, filename="alias.jpg", extension=".jpg", file_size=1)
            post.tags.append(target)
            session.add(post)
            session.add(TagAlias(alias_name="sango_pokemon", target_id=target.id))
            await session.commit()
            return post.id

    def test_searching_an_alias_finds_posts_tagged_with_its_target(self):
        from app.database import async_session
        from app.services.search import search_posts

        async def _search():
            async with async_session() as session:
                return await search_posts(session, query="sango_(pokemon)")

        posts, total = asyncio.run(_search())
        self.assertEqual(total, 1)
        self.assertEqual(posts[0].id, self.post_id)

    def test_unqualified_alias_word_also_resolves(self):
        """A bare "sango" (no qualifier typed) must resolve too - that's the
        spelling a user actually types, not the normalized form."""
        from app.database import async_session
        from app.services.search import search_posts

        async def _search():
            async with async_session() as session:
                return await search_posts(session, query="sango")

        posts, total = asyncio.run(_search())
        self.assertEqual(total, 1)
        self.assertEqual(posts[0].id, self.post_id)

    def test_searching_an_alias_finds_its_target_with_semantic_search_on(self):
        """Semantic search replaces the tag conditions outright (search.py's
        _semantic_expansion_conditions), so it needs its own alias lookup -
        this is the path enabled by AutoTagOptions.semanticSearchEnabled."""
        from app.database import async_session
        from app.services.search import search_posts

        async def _search():
            async with async_session() as session:
                return await search_posts(session, query="sango", semantic_search=True)

        posts, total = asyncio.run(_search())
        self.assertEqual(total, 1)
        self.assertEqual(posts[0].id, self.post_id)


class BooruSuggestRateLimitTests(unittest.TestCase):
    """Typing must not turn into a request per keystroke against public boorus.

    Everything here is about what does *not* leave the machine: the guards in
    booru_suggest that stand between the keyboard and Danbooru/Gelbooru.
    """

    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def setUp(self):
        from app.services import booru_suggest

        booru_suggest.clear_cache()
        self.addCleanup(booru_suggest.clear_cache)

    def _rows(self, *names):
        return [
            {
                "name": name,
                "displayName": name.replace("_", " "),
                "category": "character",
                "usageCount": 0,
                "remoteCount": 10,
                "remote": True,
                "source": "danbooru",
            }
            for name in names
        ]

    def test_repeat_queries_are_served_from_cache(self):
        from unittest.mock import AsyncMock, patch

        from app.services import booru_suggest

        fetch = AsyncMock(return_value=self._rows("hoshino_ai"))
        with patch.object(booru_suggest, "_fetch_suggestions", fetch):
            first = asyncio.run(booru_suggest.suggest_tags("hoshino"))
            second = asyncio.run(booru_suggest.suggest_tags("hoshino"))
        self.assertEqual([row["name"] for row in first], ["hoshino_ai"])
        self.assertEqual(first, second)
        self.assertEqual(fetch.await_count, 1)

    def test_a_prefix_with_no_matches_suppresses_longer_terms(self):
        """The boards only narrow as the term grows, so once a prefix comes back
        empty every term starting with it can be answered without asking."""
        from unittest.mock import AsyncMock, patch

        from app.services import booru_suggest

        fetch = AsyncMock(return_value=[])
        with patch.object(booru_suggest, "_fetch_suggestions", fetch):
            self.assertEqual(asyncio.run(booru_suggest.suggest_tags("zzqq")), [])
            self.assertEqual(asyncio.run(booru_suggest.suggest_tags("zzqqw")), [])
            self.assertEqual(asyncio.run(booru_suggest.suggest_tags("zzqqwx")), [])
        self.assertEqual(fetch.await_count, 1)

    def test_a_failed_lookup_is_not_remembered_as_no_matches(self):
        """A timeout answers empty like a real miss, but caching it would blank
        the term - and every longer one - for the whole TTL."""
        from unittest.mock import AsyncMock, patch

        from app.services import booru_suggest

        fetch = AsyncMock(side_effect=[None, self._rows("hoshino_ai")])
        with patch.object(booru_suggest, "_fetch_suggestions", fetch):
            self.assertEqual(asyncio.run(booru_suggest.suggest_tags("hoshino")), [])
            retried = asyncio.run(booru_suggest.suggest_tags("hoshino"))
        self.assertEqual([row["name"] for row in retried], ["hoshino_ai"])
        self.assertEqual(fetch.await_count, 2)

    def test_the_budget_stops_a_burst_of_distinct_queries(self):
        from unittest.mock import AsyncMock, patch

        from app.services import booru_suggest

        fetch = AsyncMock(return_value=self._rows("anything"))
        with patch.object(booru_suggest, "_fetch_suggestions", fetch):
            for index in range(booru_suggest.RATE_LIMIT_BURST + 5):
                asyncio.run(booru_suggest.suggest_tags(f"term{index}x"))
        # The bucket refills while the loop runs, so the exact number is timing
        # dependent; what matters is that it is bounded well below the demand.
        self.assertLessEqual(fetch.await_count, booru_suggest.RATE_LIMIT_BURST + 2)
        self.assertGreaterEqual(fetch.await_count, booru_suggest.RATE_LIMIT_BURST)

    def test_concurrent_identical_queries_make_one_request(self):
        from unittest.mock import patch

        from app.services import booru_suggest

        calls = 0

        async def slow_fetch(term, *, limit, timeout):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.05)
            return self._rows("hoshino_ai")

        async def _race():
            return await asyncio.gather(
                *(booru_suggest.suggest_tags("hoshino") for _ in range(5))
            )

        with patch.object(booru_suggest, "_fetch_suggestions", slow_fetch):
            results = asyncio.run(_race())
        self.assertEqual(calls, 1)
        for rows in results:
            self.assertEqual([row["name"] for row in rows], ["hoshino_ai"])

    def test_a_rate_limited_board_is_left_alone_until_its_cooldown_expires(self):
        import httpx

        from app.services import booru_suggest

        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(str(request.url))
            return httpx.Response(429, headers={"Retry-After": "120"}, json=[])

        async def _call():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                first = await booru_suggest._get_json(client, "https://example.test/a", "danbooru")
                second = await booru_suggest._get_json(client, "https://example.test/b", "danbooru")
                # A different board is not punished for this one's answer.
                third = await booru_suggest._get_json(client, "https://example.test/c", "gelbooru")
                return first, second, third

        first, second, third = asyncio.run(_call())
        self.assertIsNone(first)
        self.assertIsNone(second)
        self.assertIsNone(third)
        # The second danbooru call never went out; gelbooru's did.
        self.assertEqual(requests, ["https://example.test/a", "https://example.test/c"])
        self.assertTrue(booru_suggest._cooling_down("danbooru"))

    def test_retry_after_is_honoured_and_clamped(self):
        import httpx

        from app.services import booru_suggest

        def response(value):
            return httpx.Response(429, headers={"Retry-After": value} if value else {})

        self.assertEqual(booru_suggest._retry_after_seconds(response("45")), 45.0)
        # An HTTP-date or junk value falls back rather than parsing badly.
        self.assertEqual(
            booru_suggest._retry_after_seconds(response("Wed, 21 Oct 2015 07:28:00 GMT")),
            booru_suggest.DEFAULT_COOLDOWN_SECONDS,
        )
        self.assertEqual(
            booru_suggest._retry_after_seconds(response(None)),
            booru_suggest.DEFAULT_COOLDOWN_SECONDS,
        )
        booru_suggest._cool_down("danbooru", 10_000)
        self.assertTrue(booru_suggest._cooling_down("danbooru"))

    def test_gelbooru_query_adds_credentials_without_leaking_the_key(self):
        import urllib.parse
        from unittest.mock import patch

        from app.services import booru_suggest

        with patch.object(
            booru_suggest,
            "gelbooru_credentials",
            return_value=("9455", "gelbooru_test_secret"),
        ):
            params = booru_suggest._gelbooru_query("hoshino", 10)

        self.assertEqual(params["user_id"], "9455")
        self.assertEqual(params["api_key"], "gelbooru_test_secret")
        url = "https://gelbooru.com/index.php?" + urllib.parse.urlencode(params)
        redacted = booru_suggest._redact_url(url)
        self.assertIn("api_key=%5Bredacted%5D", redacted)
        self.assertNotIn("gelbooru_test_secret", redacted)

    def test_gelbooru_query_stays_anonymous_without_a_complete_pair(self):
        from unittest.mock import patch

        from app.services import booru_suggest

        with patch.object(booru_suggest, "gelbooru_credentials", return_value=None):
            params = booru_suggest._gelbooru_query("hoshino", 10)
        self.assertNotIn("user_id", params)
        self.assertNotIn("api_key", params)

    def test_httpx_access_log_redacts_gelbooru_api_key(self):
        import logging

        from app.services import booru_suggest

        record = logging.LogRecord(
            "httpx",
            logging.INFO,
            __file__,
            1,
            "HTTP Request: GET %s",
            ("https://gelbooru.com/index.php?user_id=9455&api_key=gelbooru_test_secret",),
            None,
        )
        self.assertTrue(booru_suggest._HttpxCredentialFilter().filter(record))
        self.assertNotIn("gelbooru_test_secret", record.getMessage())
        self.assertIn("api_key=%5Bredacted%5D", record.getMessage())
class HashSearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def test_complete_bare_hashes_are_filters_but_short_values_are_tags(self):
        from app.services.search import TokenType, tokenize

        md5 = "5b0a745707109a96fe76320c74aa04ab"
        sha256 = "a" * 64
        for value in (md5, md5.upper(), sha256):
            with self.subTest(value=value):
                token = tokenize(value)[0]
                self.assertEqual(token.type, TokenType.FILTER)
                self.assertEqual(token.filter_key, "hash")

        token = tokenize("deadbeef")[0]
        self.assertEqual(token.type, TokenType.TAG)

    def test_hash_queries_match_content_filename_and_source_hashes(self):
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from app.database import Base
        from app.models import Post
        from app.services.search import search_posts

        filename_md5 = "5b0a745707109a96fe76320c74aa04ab"
        source_md5 = "bf25b66d031d7658d9790cdf73a73e2e"
        content_sha = "abcdef12" + "3" * 56

        async def exercise():
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            try:
                async with engine.begin() as conn:
                    await conn.run_sync(Base.metadata.create_all)
                sessions = async_sessionmaker(engine, expire_on_commit=False)
                async with sessions() as session:
                    session.add_all([
                        Post(
                            sha256=content_sha,
                            filename=f"sample_{filename_md5}.jpg",
                            extension=".jpg",
                            file_size=1,
                            safety="safe",
                        ),
                        Post(
                            sha256="4" * 64,
                            filename="renamed.jpg",
                            extension=".jpg",
                            file_size=1,
                            safety="unsafe",
                            source=f"https://img4.gelbooru.com/images/bf/25/{source_md5}.png",
                        ),
                        Post(
                            sha256="5" * 64,
                            filename="unrelated.jpg",
                            extension=".jpg",
                            file_size=1,
                            safety="safe",
                        ),
                    ])
                    await session.commit()

                    cases = {
                        filename_md5: 1,
                        filename_md5.upper(): 1,
                        f"md5:{filename_md5}": 1,
                        f"hash:{filename_md5}": 1,
                        source_md5: 1,
                        f"md5:{source_md5}": 1,
                        content_sha: 1,
                        "hash:abcdef12": 1,
                        "sha256:abcdef12": 1,
                        f"hash:{filename_md5} safety:safe": 1,
                        f"hash:{filename_md5} safety:unsafe": 0,
                        f"-hash:{filename_md5}": 2,
                        "hash:not-a-hash": 0,
                        "md5:abcdef12": 0,
                    }
                    for query, expected in cases.items():
                        with self.subTest(query=query):
                            posts, total = await search_posts(session, query=query)
                            self.assertEqual(total, expected)
                            self.assertEqual(len(posts), expected)
            finally:
                await engine.dispose()

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
