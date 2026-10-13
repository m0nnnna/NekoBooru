import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_tag_support as support


class AutoTagSemanticTests(unittest.TestCase):
    """Semantic (Qwen) options, prompts and output parsing."""

    @classmethod
    def setUpClass(cls):
        support.add_backend_path()

    def test_qwen_analysis_image_downscales_large_inputs(self):
        from PIL import Image
        from app.services import auto_tagger

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "large.png"
            Image.new("RGB", (1621, 2432), (120, 60, 30)).save(source)

            analysis = auto_tagger._qwen_analysis_image(source, max_side=900)

            self.assertNotEqual(analysis, source)
            try:
                with Image.open(analysis) as img:
                    self.assertEqual(max(img.size), 900)
                    self.assertEqual(img.size, (600, 900))
            finally:
                shutil.rmtree(analysis.parent, ignore_errors=True)

    def test_qwen_analysis_image_keeps_small_inputs(self):
        from PIL import Image
        from app.services import auto_tagger

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "small.png"
            Image.new("RGB", (600, 900), (120, 60, 30)).save(source)

            self.assertEqual(auto_tagger._qwen_analysis_image(source, max_side=900), source)

    def test_qwen_video_frame_count_validates_separately(self):
        from app.services.auto_tagger import default_options, validate_options

        defaults = default_options()
        self.assertFalse(defaults.qwenVideoUseFps)

        opts = validate_options({"videoMaxFrames": 3, "qwenVideoUseFps": True, "qwenVideoMaxFrames": 99})

        self.assertEqual(opts.videoMaxFrames, 3)
        self.assertTrue(opts.qwenVideoUseFps)
        self.assertEqual(opts.qwenVideoMaxFrames, 64)

    def test_qwen_two_fps_timestamps_are_capped(self):
        from app.services.auto_tagger import _fps_timestamps

        self.assertEqual(_fps_timestamps(2.0, fps=2.0, max_frames=20), [0.25, 0.75, 1.25, 1.75])
        self.assertEqual(_fps_timestamps(10.0, fps=2.0, max_frames=3), [0.25, 0.75, 1.25])

    def test_video_semantic_prompt_instructs_temporal_reasoning(self):
        from app.services.auto_tagger import _semantic_prompt_with_context, default_options

        prompt = _semantic_prompt_with_context(default_options(), {"mediaType": "video"})

        self.assertIn("temporal video sequence", prompt)
        self.assertIn("Do not describe the input as a grid", prompt)
        self.assertIn("Do not mention frame counts", prompt)
        self.assertIn("explain exactly what is lewd", prompt)
        self.assertIn("Do not rely only on suggestive pose", prompt)

    def test_gguf_contact_sheet_prompt_explains_grid_transport(self):
        from app.services.auto_tagger import AutoTagOptions, QwenGgufSemanticTagger

        tagger = QwenGgufSemanticTagger("qwen_gguf_q4")

        with patch.object(tagger, "ensure_loaded", return_value=True), \
             patch("app.services.auto_tagger._image_data_url", return_value="data:image/jpeg;base64,abc"), \
             patch("app.services.auto_tagger._parse_semantic_json", return_value={"tags": ["video"], "safety": "safe", "rationale": "A video."}), \
             patch("app.services.auto_tagger._sanitize_qwen_semantic_payload", side_effect=lambda parsed, context: parsed):
            captured = {}

            class FakeLlama:
                def create_chat_completion(self, **kwargs):
                    captured.update(kwargs)
                    return {"choices": [{"message": {"content": "{\"tags\":[\"video\"],\"safety\":\"safe\",\"rationale\":\"A video.\"}"}}]}

            tagger._llm = FakeLlama()
            tagger._loaded = True
            tagger.analyze_image(Path("frame-grid.jpg"), context={"mediaType": "video", "qwenInputMode": "contact_sheet"}, opts=AutoTagOptions())

        prompt = captured["messages"][0]["content"][0]["text"]
        self.assertIn("You are an expert video analysis model", prompt)
        self.assertIn("arranged in a grid only because of the runtime input format", prompt)
        self.assertIn("Do not mention how the frames are presented", prompt)

    def test_repetitive_qwen_raw_output_is_compacted(self):
        from app.services.auto_tagger import _compact_semantic_raw_output

        raw = '{"tags": [' + ", ".join(['"cow_horn"', '"cow_tail"', '"animal_ears"', '"white_horn"'] * 16)
        parsed = {
            "tags": ["cow_horn", "cow_tail", "animal_ears", "white_horn"],
            "safety": "safe",
            "rationale": "A video shows a subject in a cow-themed outfit.",
        }

        compact = _compact_semantic_raw_output(raw, parsed)
        data = json.loads(compact)

        self.assertTrue(data["compacted"])
        self.assertEqual(data["tags"], parsed["tags"])
        self.assertLess(len(compact), 400)

    def test_semantic_prompt_can_be_customized_and_validated(self):
        from app.services.auto_tagger import DEFAULT_SEMANTIC_PROMPT, validate_options

        custom = "Return tags about vaporwave_edit and city_pop."
        opts = validate_options({"semanticPrompt": custom})
        self.assertEqual(opts.semanticPrompt, custom)

        fallback = validate_options({"semanticPrompt": "  "})
        self.assertEqual(fallback.semanticPrompt, DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("Tags in priority order:", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("Semantic description:", DEFAULT_SEMANTIC_PROMPT)
        self.assertLess(
            DEFAULT_SEMANTIC_PROMPT.index("Semantic description:"),
            DEFAULT_SEMANTIC_PROMPT.index("Tags in priority order:"),
        )
        self.assertNotIn("Political symbol rules:", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("6-28", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("cow_print_outfit", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("bikini", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("exact pose/action", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("lying", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("If lewd, sketchy, unsafe, or nsfw", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("If lewd or nsfw explain what is erotic about it", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("concrete visible evidence", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("Do not rely only on suggestive pose", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("Example expected rationale style:", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("safety_reason", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("adult erotic content", DEFAULT_SEMANTIC_PROMPT)
        self.assertIn("do not output metadata tags", DEFAULT_SEMANTIC_PROMPT)

        capped = validate_options({"semanticPrompt": "x" * 5000})
        self.assertEqual(len(capped.semanticPrompt), 4000)

        legacy_default = (
            "Return compact JSON only with keys tags, safety, rationale. "
            "Use snake_case tags. Look for higher-level context such as political_edit, meme_edit, amv, music_video, "
            "captioned, protest, politician, propaganda, and contextual edit signals only when visually or transcript supported. "
            "Use national_socialism only for clear Nazi/far-right symbols such as a swastika, sonnenrad, or black_sun. "
            "Use communism only for clear communist symbols such as a hammer_and_sickle or communist red star. "
            "If transcript or audio evidence suggests a song or music-driven edit, include music and edit."
        )
        migrated = validate_options({"semanticPrompt": legacy_default})
        self.assertEqual(migrated.semanticPrompt, DEFAULT_SEMANTIC_PROMPT)

    def test_semantic_generation_limits_allow_richer_rationale_and_tags(self):
        from app.services.auto_tagger import AutoTagOptions, QWEN_GGUF_MAX_TOKENS, QWEN_MAX_NEW_TOKENS, _semantic_tag_limit

        self.assertGreaterEqual(QWEN_MAX_NEW_TOKENS, 512)
        self.assertGreaterEqual(QWEN_GGUF_MAX_TOKENS, 512)
        self.assertEqual(_semantic_tag_limit(AutoTagOptions(maxTags=28)), 28)
        self.assertEqual(_semantic_tag_limit(AutoTagOptions(maxTags=80)), 60)

    def test_semantic_prompt_and_search_flags_validate(self):
        from app.services.auto_tagger import validate_options

        defaults = validate_options({})
        self.assertTrue(defaults.semanticPromptEnabled)
        self.assertFalse(defaults.semanticSearchEnabled)

        opts = validate_options({"semanticPromptEnabled": False, "semanticSearchEnabled": True})
        self.assertFalse(opts.semanticPromptEnabled)
        self.assertTrue(opts.semanticSearchEnabled)

    def test_semantic_prompt_includes_visual_tag_hints(self):
        from app.services.auto_tagger import AutoTagOptions, _semantic_prompt_with_context

        prompt = _semantic_prompt_with_context(
            AutoTagOptions(),
            {
                "visualTagHints": {
                    "tags": ["cow_ears", "animal_ears", "cow_tail", "bikini"],
                    "characterTags": ["methode"],
                    "copyrightTags": ["goddess_of_victory_nikke"],
                    "models": ["camie-tagger-v2"],
                }
            },
        )

        self.assertIn("Model tag hints:", prompt)
        self.assertIn("specific animal type", prompt)
        self.assertIn("cow_ears", prompt)
        self.assertIn("cow_tail", prompt)
        self.assertNotIn("methode", prompt)
        self.assertNotIn("goddess_of_victory_nikke", prompt)

    def test_visual_tag_hints_are_deduped_and_compacted(self):
        from app.services.auto_tagger import AutoTagResult, _add_visual_tag_hints, _compact_semantic_context

        context = {}
        _add_visual_tag_hints(
            context,
            [
                AutoTagResult(
                    tags=["cow_ears", "cow_ears", "animal_ears"],
                    character_tags=["methode", "methode"],
                    copyright_tags=["goddess_of_victory_nikke"],
                    model="camie-tagger-v2",
                )
            ],
        )

        compact = _compact_semantic_context(context)
        hints = compact["visualTagHints"]
        self.assertEqual(hints["tags"], ["cow_ears", "animal_ears"])
        self.assertNotIn("characterTags", hints)
        self.assertNotIn("copyrightTags", hints)

    def test_semantic_json_empty_tags_falls_back_to_rationale_tags(self):
        from app.services.auto_tagger import _parse_semantic_json

        parsed = _parse_semantic_json(
            '{"tags":[],"safety":"safe","rationale":"The image depicts a person in a pink bikini '
            'with strawberry patterns, taken indoors with natural lighting. There are no visible '
            'political, extremist, or contextual edit signals."}'
        )

        self.assertIn("person", parsed["tags"])
        self.assertIn("bikini", parsed["tags"])
        self.assertIn("indoors", parsed["tags"])
        self.assertIn("patterned_clothing", parsed["tags"])
        self.assertNotIn("political_edit", parsed["tags"])

    def test_semantic_text_does_not_match_man_inside_female(self):
        from app.services.auto_tagger import _parse_semantic_json

        parsed = _parse_semantic_json(
            '{"tags":[],"safety":"unsafe","rationale":"The image is a close-up selfie '
            'of a female with blond hair wearing a pink strawberry-print bikini indoors."}'
        )

        self.assertIn("woman", parsed["tags"])
        self.assertIn("bikini", parsed["tags"])
        self.assertNotIn("man", parsed["tags"])

    def test_semantic_json_supplements_pose_tags_from_rationale(self):
        from app.services.auto_tagger import _parse_semantic_json

        parsed = _parse_semantic_json(
            '{"tags":["photo","female","bed"],"safety":"safe",'
            '"rationale":"The image is a close-up portrait of a female lying on a bed while looking at the viewer."}'
        )

        self.assertIn("photo", parsed["tags"])
        self.assertIn("lying", parsed["tags"])
        self.assertIn("looking_at_viewer", parsed["tags"])

    def test_semantic_json_accepts_description_safety_classification_shape(self):
        from app.services.auto_tagger import _parse_semantic_json

        parsed = _parse_semantic_json(
            '{"tags":["photo","lingerie"],'
            '"description":"A woman is sitting indoors in lingerie with visible cleavage.",'
            '"safety_classification":"adult_erotic",'
            '"safety_reason":"Revealing lingerie and visible cleavage.",'
            '"confidence":"high"}'
        )

        self.assertEqual(parsed["safety"], "unsafe")
        self.assertIn("visible cleavage", parsed["rationale"])
        self.assertIn("lingerie", parsed["tags"])

    def test_frame_metadata_tags_are_filtered_from_semantic_output(self):
        from app.services.auto_tagger import _parse_semantic_json

        parsed = _parse_semantic_json(
            '{"tags":["video","three_frames","frame_1","frame_2","t_2.51s","smiling"],'
            '"safety":"safe","rationale":"The sampled frames show a smiling subject over time."}'
        )

        self.assertIn("video", parsed["tags"])
        self.assertIn("smiling", parsed["tags"])
        self.assertNotIn("three_frames", parsed["tags"])
        self.assertNotIn("frame_1", parsed["tags"])
        self.assertNotIn("frame_2", parsed["tags"])
        self.assertNotIn("t_2.51s", parsed["tags"])

    def test_qwen_semantic_payload_removes_identity_hint_guesses(self):
        from app.services.auto_tagger import _sanitize_qwen_semantic_payload

        parsed = {
            "tags": ["1girl", "black_hair", "tifa_lockhart", "final_fantasy_vii", "lingerie"],
            "rationale": (
                "The image consists of three frames showing a woman in lingerie. "
                "The character is identified as Tifa Lockhart from Final Fantasy VII, but this may be wrong."
            ),
        }
        context = {
            "visualTagHints": {
                "tags": ["black_hair", "lingerie"],
                "characterTags": ["tifa_lockhart"],
                "copyrightTags": ["final_fantasy_vii"],
            }
        }

        clean = _sanitize_qwen_semantic_payload(parsed, context)

        self.assertIn("black_hair", clean["tags"])
        self.assertIn("lingerie", clean["tags"])
        self.assertNotIn("tifa_lockhart", clean["tags"])
        self.assertNotIn("final_fantasy_vii", clean["tags"])
        self.assertNotIn("three frames", clean["rationale"].lower())
        self.assertNotIn("tifa", clean["rationale"].lower())

    def test_qwen_semantic_payload_removes_contact_sheet_language(self):
        from app.services.auto_tagger import _sanitize_qwen_semantic_payload

        parsed = {
            "tags": ["video", "selfie", "frame_1", "t_2.51s", "grid", "photo_collage"],
            "rationale": (
                "The image is a series of 8 frames showing a woman smiling. "
                "The frames are arranged in a grid, indicating a video or slideshow format. "
                "The image is a grid of selfies featuring one subject indoors. "
                "The setting is indoors."
            ),
        }

        clean = _sanitize_qwen_semantic_payload(parsed, {})

        self.assertIn("video", clean["tags"])
        self.assertIn("selfie", clean["tags"])
        self.assertNotIn("frame_1", clean["tags"])
        self.assertNotIn("t_2.51s", clean["tags"])
        self.assertNotIn("grid", clean["tags"])
        self.assertNotIn("photo_collage", clean["tags"])
        rationale = clean["rationale"].lower()
        self.assertNotIn("8 frames", rationale)
        self.assertNotIn("arranged in a grid", rationale)
        self.assertNotIn("grid of", rationale)
        self.assertNotIn("slideshow", rationale)
        self.assertIn("one subject", rationale)

    def test_qwen_semantic_payload_rewrites_frame_rationale_to_video(self):
        from app.services.auto_tagger import _sanitize_qwen_semantic_payload

        parsed = {
            "tags": ["video", "sitting"],
            "rationale": (
                "A single woman is shown in a series of frames, posing indoors. "
                "The poses vary across the frames, including touching her hair. "
                "The frames show long black hair and lingerie."
            ),
        }

        clean = _sanitize_qwen_semantic_payload(parsed, {"mediaType": "video"})
        rationale = clean["rationale"].lower()

        self.assertIn("shown in the video", rationale)
        self.assertIn("throughout the video", rationale)
        self.assertIn("the video shows", rationale)
        self.assertNotIn("series of frames", rationale)
        self.assertNotIn("across the frames", rationale)

    def test_qwen_semantic_payload_rewrites_video_frames_to_video(self):
        from app.services.auto_tagger import _sanitize_qwen_semantic_payload

        parsed = {
            "tags": ["video", "lingerie", "cleavage"],
            "rationale": (
                "The video frames show a woman posing indoors in lingerie. "
                "The content is lewd because the lingerie exposes cleavage and emphasizes the chest."
            ),
        }

        clean = _sanitize_qwen_semantic_payload(parsed, {"mediaType": "video"})
        rationale = clean["rationale"].lower()

        self.assertIn("the video shows", rationale)
        self.assertIn("exposes cleavage", rationale)
        self.assertIn("emphasizes the chest", rationale)
        self.assertNotIn("video frames show", rationale)

    def test_semantic_malformed_json_recovers_declared_tag_list(self):
        from app.services.auto_tagger import _parse_semantic_json

        parsed = _parse_semantic_json(
            '{"tags": ["anime", "female", "one_subject", "bikini", "red_bikini", '
            '"swastika", "blond_hair", "closed_eyes", "sunlight", "sky_background", '
            '"high_angle", "meme_edit", "has_text"], "safety": "explicit", '
            '"rationale": "The bikini has swastikas visible on both pieces."'
        )

        for tag in ["anime", "female", "one_subject", "red_bikini", "swastika", "high_angle", "meme_edit", "has_text"]:
            self.assertIn(tag, parsed["tags"])
        self.assertIn("national_socialism", parsed["tags"])
        self.assertEqual(parsed["safety"], "unsafe")

    def test_semantic_json_supplements_symbol_tags_from_rationale(self):
        from app.services.auto_tagger import _parse_semantic_json

        parsed = _parse_semantic_json(
            '{"tags":["woman","bikini","swimwear"],"safety":"sketchy",'
            '"rationale":"The red bikini has swastikas clearly visible on both pieces."}'
        )

        self.assertIn("woman", parsed["tags"])
        self.assertIn("swastika", parsed["tags"])
        self.assertIn("national_socialism", parsed["tags"])

    def test_semantic_json_does_not_add_negated_symbol_tags(self):
        from app.services.auto_tagger import _parse_semantic_json

        parsed = _parse_semantic_json(
            '{"tags":["woman","bikini"],"safety":"safe",'
            '"rationale":"There is no visible swastika, sonnenrad, or other extremist symbol."}'
        )

        self.assertNotIn("swastika", parsed["tags"])
        self.assertNotIn("sonnenrad", parsed["tags"])
        self.assertNotIn("national_socialism", parsed["tags"])


if __name__ == "__main__":
    unittest.main()
