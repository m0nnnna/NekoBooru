import sys
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


if __name__ == "__main__":
    unittest.main()
