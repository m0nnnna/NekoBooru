import unittest
from pathlib import Path
from unittest.mock import patch

import auto_tag_support as support


class AutoTagResultTests(unittest.TestCase):
    """Tag results: video frame sampling, result merging and post-processing, safety, media fetching, booru lookups."""

    @classmethod
    def setUpClass(cls):
        support.add_backend_path()

    def test_video_timestamp_strategy_samples_middle_when_single_frame(self):
        from app.services.auto_tagger import AutoTagOptions, _timestamps

        self.assertEqual(_timestamps(6.0, AutoTagOptions(videoMaxFrames=1)), [3.0])

    def test_pinned_video_frame_replaces_sampling(self):
        from app.services.auto_tagger import AutoTagOptions, _timestamps

        opts = AutoTagOptions(videoMaxFrames=4, videoFrameTime=7.25)
        self.assertEqual(_timestamps(30.0, opts), [7.25])
        # Past the end clamps to the last usable frame rather than failing.
        self.assertEqual(_timestamps(10.0, AutoTagOptions(videoFrameTime=99.0)), [9.95])
        # Unset keeps the old behaviour.
        self.assertEqual(_timestamps(6.0, AutoTagOptions(videoMaxFrames=1)), [3.0])

    def test_pinned_video_frame_is_validated(self):
        from app.services.auto_tagger import validate_options

        self.assertEqual(validate_options({"videoFrameTime": "12.5"}).videoFrameTime, 12.5)
        self.assertEqual(validate_options({"videoFrameTime": -3}).videoFrameTime, 0.0)
        for empty in (None, "", "nonsense"):
            self.assertIsNone(validate_options({"videoFrameTime": empty}).videoFrameTime, empty)

    def test_video_timestamp_strategy_samples_multiple_for_edits(self):
        from app.services.auto_tagger import AutoTagOptions, _timestamps

        self.assertEqual(
            _timestamps(90.0, AutoTagOptions(videoMaxFrames=2)),
            [30.0, 60.0],
        )
        self.assertEqual(
            _timestamps(100.0, AutoTagOptions(videoMaxFrames=3)),
            [25.0, 50.0, 75.0],
        )
        self.assertEqual(
            _timestamps(100.0, AutoTagOptions(videoMaxFrames=4)),
            [20.0, 40.0, 60.0, 80.0],
        )

    def test_combine_results_merges_optional_model_tags(self):
        from app.services.auto_tagger import AutoTagResult, _combine_results

        result = _combine_results([
            AutoTagResult(tags=["1girl"], safety="safe", categories={"1girl": "general"}, model="wd", enabled=True),
            AutoTagResult(
                character_tags=["hatsune_miku"],
                copyright_tags=["vocaloid"],
                safety="unsafe",
                categories={"hatsune_miku": "character", "vocaloid": "copyright"},
                model="camie",
                enabled=True,
            ),
        ])

        self.assertIn("1girl", result.tags)
        self.assertIn("hatsune_miku", result.character_tags)
        self.assertIn("vocaloid", result.copyright_tags)
        self.assertEqual(result.safety, "unsafe")
        self.assertEqual(result.categories["hatsune_miku"], "character")

    def test_post_process_adds_media_type_tag(self):
        from app.services.auto_tagger import AutoTagOptions, AutoTagResult, _post_process

        image = _post_process(AutoTagResult(tags=["meme"]), Path("sample.jpg"), AutoTagOptions())
        video = _post_process(AutoTagResult(tags=["meme"]), Path("sample.mp4"), AutoTagOptions())
        gif = _post_process(AutoTagResult(tags=["meme"]), Path("sample.gif"), AutoTagOptions())

        self.assertIn("image", image.tags)
        self.assertIn("video", video.tags)
        self.assertIn("gif", gif.tags)
        self.assertEqual(video.categories["video"], "meta")

    def test_twitter_media_url_normalizes_to_original_variant(self):
        from app.routers.uploads_fetch import _normalize_fetch_url

        url = "https://pbs.twimg.com/media/HKSUfpEa0AALL8x?format=jpg&name=900x900"

        self.assertEqual(
            _normalize_fetch_url(url),
            "https://pbs.twimg.com/media/HKSUfpEa0AALL8x?format=jpg&name=orig",
        )
        self.assertEqual(
            _normalize_fetch_url("https://pbs.twimg.com/media/HKSUfpEa0AALL8x.jpg"),
            "https://pbs.twimg.com/media/HKSUfpEa0AALL8x.jpg?format=jpg&name=orig",
        )
        self.assertEqual(
            _normalize_fetch_url("https://example.com/media/HKSUfpEa0AALL8x?format=jpg&name=900x900"),
            "https://example.com/media/HKSUfpEa0AALL8x?format=jpg&name=900x900",
        )

    def test_sankaku_media_uses_app_referer_and_rejects_placeholder(self):
        from app.routers.uploads_fetch import _is_sankaku_hotlink_placeholder, _media_referer

        chan = "https://chan.sankakucomplex.com/en/posts/e8M5Yy3XpMz"
        self.assertEqual(_media_referer("s.sankakucomplex.com", chan), "https://sankaku.app/")
        self.assertEqual(_media_referer("v.sankakucomplex.com", chan), "https://sankaku.app/")
        self.assertEqual(_media_referer("chan.sankakucomplex.com", chan), chan)
        self.assertEqual(_media_referer("img.example", "https://img.example/"), "https://img.example/")
        self.assertTrue(_is_sankaku_hotlink_placeholder("https://chan.sankakucomplex.com/redirect.png?e=1&m=x"))
        self.assertFalse(_is_sankaku_hotlink_placeholder("https://s.sankakucomplex.com/o/62/4e/abc.jpg?e=1&m=x"))

    def test_danbooru_media_is_fetched_with_an_honest_user_agent(self):
        from app.routers.uploads_fetch import BROWSER_USER_AGENT, _media_user_agent

        self.assertTrue(_media_user_agent("cdn.donmai.us").startswith("NekoBooru/"))
        self.assertTrue(_media_user_agent("danbooru.donmai.us").startswith("NekoBooru/"))
        self.assertEqual(_media_user_agent("donmai.us.evil.example"), BROWSER_USER_AGENT)
        self.assertEqual(_media_user_agent("img.example"), BROWSER_USER_AGENT)

    def test_post_process_filters_default_noisy_tags(self):
        from app.services.auto_tagger import AutoTagOptions, AutoTagResult, _post_process

        result = _post_process(
            AutoTagResult(
                tags=["meme", "card_medium", "outline"],
                categories={"meme": "general", "card_medium": "general", "outline": "general"},
            ),
            Path("sample.png"),
            AutoTagOptions(),
        )

        self.assertIn("meme", result.tags)
        self.assertIn("image", result.tags)
        self.assertNotIn("card_medium", result.tags)
        self.assertNotIn("outline", result.tags)

    def test_safety_rating_requires_strong_evidence_for_promotion(self):
        from app.services.auto_tagger import AutoTagOptions, safety_from_rating

        opts = AutoTagOptions(unsafeThreshold=0.70, sketchyThreshold=0.45)

        self.assertEqual(safety_from_rating({"questionable": 0.50}, opts), "safe")
        self.assertEqual(safety_from_rating({"sensitive": 0.60}, opts), "safe")
        self.assertEqual(safety_from_rating({"explicit": 0.71}, opts), "unsafe")
        self.assertEqual(safety_from_rating({"questionable": 0.78}, opts), "sketchy")

    def test_semantic_safety_aliases_promote_safety(self):
        from app.services.auto_tagger import AutoTagOptions, normalize_safety_label, promote_safety

        opts = AutoTagOptions(applySafety=True)

        self.assertEqual(normalize_safety_label("explicit"), "unsafe")
        self.assertEqual(normalize_safety_label("nsfw"), "unsafe")
        self.assertEqual(normalize_safety_label("nude"), "unsafe")
        self.assertEqual(normalize_safety_label("nudity"), "unsafe")
        self.assertEqual(normalize_safety_label("suggestive"), "sketchy")
        self.assertEqual(promote_safety("safe", "explicit", opts), "unsafe")
        self.assertEqual(promote_safety("safe", "partial_nudity", opts), "sketchy")

    def test_safety_verdict_corrects_rating_in_both_directions(self):
        from app.services.auto_tagger import AutoTagOptions, promote_safety

        opts = AutoTagOptions(applySafety=True)

        # A mis-rated safe post is loosened, not only a mis-rated NSFW one tightened.
        self.assertEqual(promote_safety("unsafe", "safe", opts), "safe")
        self.assertEqual(promote_safety("sketchy", "safe", opts), "safe")
        self.assertEqual(promote_safety("unsafe", "sketchy", opts), "sketchy")
        self.assertEqual(promote_safety("safe", "unsafe", opts), "unsafe")
        # No verdict keeps the rating; so does turning safety off.
        self.assertEqual(promote_safety("unsafe", None, opts), "unsafe")
        self.assertEqual(promote_safety("unsafe", "safe", AutoTagOptions(applySafety=False)), "unsafe")

    def test_meaningful_ocr_text_filters_blank_or_junk_text(self):
        from app.services.auto_tagger import _meaningful_ocr_text

        self.assertFalse(_meaningful_ocr_text(""))
        self.assertFalse(_meaningful_ocr_text(" . "))
        self.assertFalse(_meaningful_ocr_text("??"))
        self.assertFalse(_meaningful_ocr_text("TAX"))
        self.assertFalse(_meaningful_ocr_text("logo"))
        self.assertTrue(_meaningful_ocr_text("subtitle line"))
        self.assertTrue(_meaningful_ocr_text("hello world"))
        self.assertTrue(_meaningful_ocr_text("2026 election"))

    def test_whisper_song_transcript_adds_music_and_edit_tags(self):
        from app.services.auto_tagger import _whisper_tags_from_text

        tags = _whisper_tags_from_text("[Music] singing starts")

        self.assertIn("music", tags)
        self.assertIn("edit", tags)
        self.assertIn("has_speech", tags)

    def test_source_spellings_survive_result_merging(self):
        """The model's own spelling is kept so the UI can show "miyu (blue archive)"."""
        from app.services.auto_tagger import AutoTagResult, _combine_results

        first = AutoTagResult(
            tags=["blue_archive"],
            character_tags=["miyu_blue_archive"],
            categories={"blue_archive": "copyright", "miyu_blue_archive": "character"},
            display_names={"blue_archive": "blue archive", "miyu_blue_archive": "miyu (blue archive)"},
            model="cl-tagger-v2",
            enabled=True,
        )
        second = AutoTagResult(
            tags=["halo"],
            categories={"halo": "general"},
            display_names={"halo": "halo"},
            model="camie-tagger-v2",
            enabled=True,
        )

        combined = _combine_results([first, second])

        self.assertEqual(combined.display_names["miyu_blue_archive"], "miyu (blue archive)")
        self.assertEqual(combined.display_names["blue_archive"], "blue archive")
        self.assertEqual(combined.display_names["halo"], "halo")

    def test_qualified_display_name_keeps_only_the_parentheses(self):
        """Every tagger vocabulary is Danbooru-shaped, so one rule covers them all."""
        from app.services.auto_tagger import normalize_tag, qualified_display_name

        # WD/PixAI/Camie write underscores; CL writes spaces. Same spelling.
        self.assertEqual(qualified_display_name("nami_(one_piece)"), "nami (one piece)")
        self.assertEqual(qualified_display_name("nami (one piece)"), "nami (one piece)")
        self.assertEqual(
            qualified_display_name("aris_(maid)_(blue_archive)"), "aris (maid) (blue archive)"
        )
        # Plain tags need nothing: "looking at viewer" is the UI's own fallback.
        self.assertIsNone(qualified_display_name("looking_at_viewer"))
        self.assertIsNone(qualified_display_name("1girl"))
        self.assertIsNone(qualified_display_name(""))
        # The display name must still normalize back to the stored key.
        self.assertEqual(normalize_tag(qualified_display_name("nami_(one_piece)")), "nami_one_piece")

    def test_tag_detail_falls_back_when_no_spelling_was_stored(self):
        from app.models import Tag, TagCategory
        from app.models.post import _tag_detail

        # A real (transient) instance: _tag_detail inspects the ORM state to
        # tell an unloaded relationship from an absent one.
        tag = Tag(name="miyu_blue_archive", usage_count=3)
        tag.category = TagCategory(name="character", color="#00c853")

        # Hand-typed and pre-existing tags have no stored spelling.
        detail = _tag_detail(tag)
        self.assertEqual(detail["displayName"], "miyu blue archive")
        self.assertEqual(detail["category"], "character")

        tag.display_name = "miyu (blue archive)"
        self.assertEqual(_tag_detail(tag)["displayName"], "miyu (blue archive)")

    def test_booru_lookup_only_adds_copyrights(self):
        """The live series lookup must never replace what the model produced."""
        from app.services import auto_tagger

        result = auto_tagger.AutoTagResult(
            tags=["1girl"],
            character_tags=["c.c."],
            copyright_tags=["goddess_of_victory:_nikke", "real_life"],
            categories={"c.c.": "character", "goddess_of_victory:_nikke": "copyright"},
            enabled=True,
        )

        with patch("app.services.booru_lookup.copyrights_for_characters",
                   return_value={"c.c.": "code_geass"}):
            auto_tagger._add_booru_copyrights(result, auto_tagger.AutoTagOptions(booruLookupEnabled=True))

        self.assertEqual(
            result.copyright_tags,
            ["goddess_of_victory:_nikke", "real_life", "code_geass"],
        )
        self.assertEqual(result.character_tags, ["c.c."])
        self.assertEqual(result.tags, ["1girl"])
        self.assertEqual(result.categories["code_geass"], "copyright")
        self.assertEqual(result.evidence["booruCopyrights"], ["code_geass"])

    def test_booru_lookup_never_breaks_tagging(self):
        from app.services import auto_tagger

        result = auto_tagger.AutoTagResult(
            character_tags=["c.c."], copyright_tags=["real_life"], enabled=True
        )
        opts = auto_tagger.AutoTagOptions(booruLookupEnabled=True)

        # An unreachable or slow booru must degrade to the model's own output.
        with patch("app.services.booru_lookup.copyrights_for_characters",
                   side_effect=RuntimeError("network down")):
            auto_tagger._add_booru_copyrights(result, opts)
        self.assertEqual(result.copyright_tags, ["real_life"])

        # A copyright the model already found is not duplicated.
        with patch("app.services.booru_lookup.copyrights_for_characters",
                   return_value={"c.c.": "real_life"}):
            auto_tagger._add_booru_copyrights(result, opts)
        self.assertEqual(result.copyright_tags, ["real_life"])

    def test_booru_lookup_prefers_the_stored_spelling_over_guessing(self):
        from app.services.booru_lookup import candidate_names

        # With the tagger's own spelling the upstream name is a plain
        # space-to-underscore swap, so it is tried first and no reconstruction
        # is needed.
        first = next(iter(candidate_names("miyu_blue_archive", "miyu (blue archive)")))
        self.assertEqual(first, "miyu_(blue_archive)")

        # Without it, the flattened name is tried before bracket guesses.
        guesses = list(candidate_names("miyu_blue_archive"))
        self.assertEqual(guesses[0], "miyu_blue_archive")
        self.assertIn("miyu_(blue_archive)", guesses)

    def test_remote_infer_requires_token_when_bound_to_network(self):
        from fastapi import HTTPException
        from app.routers import auto_tags

        with patch("app.routers.auto_tags.tagger_worker_token", return_value=None):
            with patch.object(auto_tags.settings, "host", "127.0.0.1"):
                auto_tags._require_worker_token(None)

            with patch.object(auto_tags.settings, "host", "0.0.0.0"):
                with self.assertRaises(HTTPException) as ctx:
                    auto_tags._require_worker_token(None)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_search_tokenizer_keeps_unknown_colon_tags_literal(self):
        from app.services.search import TokenType, tokenize

        tokens = tokenize("beatrice_re:zero rating:safe")

        self.assertEqual(tokens[0].type, TokenType.TAG)
        self.assertEqual(tokens[0].value, "beatrice_re:zero")
        self.assertEqual(tokens[1].type, TokenType.FILTER)
        self.assertEqual(tokens[1].filter_key, "rating")

    def test_search_tokenizer_keeps_negated_unknown_colon_tags_literal(self):
        from app.services.search import TokenType, tokenize

        tokens = tokenize("-beatrice_re:zero -safety:unsafe")

        self.assertEqual(tokens[0].type, TokenType.NEGATED_TAG)
        self.assertEqual(tokens[0].value, "beatrice_re:zero")
        self.assertEqual(tokens[1].type, TokenType.NEGATED_FILTER)
        self.assertEqual(tokens[1].filter_key, "safety")


if __name__ == "__main__":
    unittest.main()
