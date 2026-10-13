import time
import unittest
from unittest.mock import patch

import auto_tag_support as support


class AutoTagSearchApiTests(support.AutoTagApiTestCase):
    """Tag autocomplete, remote tag suggestions, and semantic search over saved Qwen analyses."""

    def test_remote_suggestions_are_off_until_enabled(self):
        from unittest.mock import patch

        self._upload_image_post(tags=["remote_probe_local"])
        with patch("app.services.booru_suggest.suggest_tags") as suggest:
            response = self.client.get(
                "/api/tags/autocomplete", params={"q": "remote_probe", "includeRemote": "true"}
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([row["name"] for row in response.json()], ["remote_probe_local"])
        suggest.assert_not_called()

    def test_remote_suggestions_top_up_local_matches(self):
        from unittest.mock import AsyncMock, patch

        self._upload_image_post(tags=["suggest_probe_local"])
        self._set_auto_tag_settings(booruSuggestEnabled=True)
        remote = [
            {
                "name": "suggest_probe_local",  # already local: must be dropped
                "displayName": "suggest probe local",
                "category": "character",
                "usageCount": 0,
                "remoteCount": 5,
                "remote": True,
                "source": "danbooru",
            },
            {
                "name": "suggest_probe_remote",
                "displayName": "suggest probe remote",
                "category": "character",
                "usageCount": 0,
                "remoteCount": 120,
                "remote": True,
                "source": "danbooru",
            },
        ]
        with patch("app.services.booru_suggest.suggest_tags", new=AsyncMock(return_value=remote)):
            response = self.client.get(
                "/api/tags/autocomplete", params={"q": "suggest_probe", "includeRemote": "true"}
            )
        self.assertEqual(response.status_code, 200, response.text)
        rows = response.json()
        self.assertEqual([row["name"] for row in rows], ["suggest_probe_local", "suggest_probe_remote"])
        # Local first, and its count is a real one.
        self.assertNotIn("remote", rows[0])
        added = rows[1]
        self.assertTrue(added["remote"])
        self.assertEqual(added["category"], "character")
        self.assertEqual(added["remoteCount"], 120)
        # Never presented as a local post count.
        self.assertEqual(added["usageCount"], 0)
        # Coloured from this library's own palette.
        self.assertEqual(added["categoryColor"], rows[0]["categoryColor"] and added["categoryColor"])
        self.assertTrue(added["categoryColor"].startswith("#"))

    def test_remote_suggestions_stay_out_of_plain_autocomplete(self):
        from unittest.mock import patch

        self._upload_image_post(tags=["plain_probe_local"])
        self._set_auto_tag_settings(booruSuggestEnabled=True)
        with patch("app.services.booru_suggest.suggest_tags") as suggest:
            response = self.client.get("/api/tags/autocomplete", params={"q": "plain_probe"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([row["name"] for row in response.json()], ["plain_probe_local"])
        suggest.assert_not_called()

    def test_saved_qwen_analysis_powers_semantic_search(self):
        post = self._upload_image_post(tags=["ordinary_tag"], safety="safe")
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["semanticSearchEnabled"] = True
        settings["semanticPrompt"] = "Return JSON semantic tags."

        suggestion = {
            "suggestedTags": ["ordinary_tag"],
            "suggestedSafety": "safe",
            "model": "qwen3-vl-8b",
            "durationMs": 42,
            "evidence": {
                "models": [
                    {
                        "model": "Qwen3-VL 8B GGUF Q4",
                        "durationMs": 42,
                        "evidence": {
                            "kind": "qwen_gguf",
                            "modelId": "qwen_gguf_q4",
                            "parsed": {
                                "tags": ["political_edit", "red_banner"],
                                "safety": "safe",
                                "rationale": "A political edit with a red banner in the background.",
                            },
                            "raw": '{"tags":["political_edit","red_banner"],"rationale":"red banner"}',
                        },
                    }
                ]
            },
        }

        saved = self.client.post(
            f"/api/posts/{post['id']}/ai-analysis",
            json={"suggestion": suggestion, "settings": settings, "profile": "test"},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["saved"], 1)

        loaded = self.client.get(f"/api/posts/{post['id']}/ai-analysis")
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(loaded.json()["results"][0]["semanticTags"], ["political_edit", "red_banner"])

        self.client.put("/api/auto-tags/settings", json={"settings": settings})
        search = self.client.get("/api/posts", params={"q": "red banner"})
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(search.json()["total"], 1)
        self.assertEqual(search.json()["results"][0]["id"], post["id"])

    def test_semantic_search_does_not_match_inside_compound_words(self):
        cowboy_post = self._upload_image_post(tags=["cowboy_shot"], safety="safe")
        cow_post = self._upload_image_post(tags=["cow_horns"], safety="safe")
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["semanticSearchEnabled"] = True

        cowboy_suggestion = {
            "model": "qwen3-vl-8b",
            "durationMs": 42,
            "evidence": {
                "models": [
                    {
                        "model": "Qwen3-VL 8B GGUF Q4",
                        "durationMs": 42,
                        "evidence": {
                            "kind": "qwen_gguf",
                            "modelId": "qwen_gguf_q4",
                            "parsed": {
                                "tags": ["cowboy_shot"],
                                "safety": "safe",
                                "rationale": "The image has a cowboy shot framing.",
                            },
                            "raw": '{"tags":["cowboy_shot"],"rationale":"cowboy shot framing"}',
                        },
                    }
                ]
            },
        }
        cow_suggestion = {
            "model": "qwen3-vl-8b",
            "durationMs": 42,
            "evidence": {
                "models": [
                    {
                        "model": "Qwen3-VL 8B GGUF Q4",
                        "durationMs": 42,
                        "evidence": {
                            "kind": "qwen_gguf",
                            "modelId": "qwen_gguf_q4",
                            "parsed": {
                                "tags": ["cow_horns"],
                                "safety": "safe",
                                "rationale": "The image shows visible cow horns.",
                            },
                            "raw": '{"tags":["cow_horns"],"rationale":"visible cow horns"}',
                        },
                    }
                ]
            },
        }

        saved = self.client.post(
            f"/api/posts/{cowboy_post['id']}/ai-analysis",
            json={"suggestion": cowboy_suggestion, "settings": settings, "profile": "test"},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        saved = self.client.post(
            f"/api/posts/{cow_post['id']}/ai-analysis",
            json={"suggestion": cow_suggestion, "settings": settings, "profile": "test"},
        )
        self.assertEqual(saved.status_code, 200, saved.text)

        self.client.put("/api/auto-tags/settings", json={"settings": settings})
        search = self.client.get("/api/posts", params={"q": "cow"})

        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(search.json()["total"], 1)
        self.assertEqual(search.json()["results"][0]["id"], cow_post["id"])

    def test_saved_qwen_analysis_description_can_be_edited(self):
        post = self._upload_image_post(tags=["ordinary_tag"], safety="safe")
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["semanticSearchEnabled"] = True

        suggestion = {
            "model": "qwen3-vl-8b",
            "durationMs": 42,
            "evidence": {
                "models": [
                    {
                        "model": "Qwen3-VL 8B GGUF Q4",
                        "durationMs": 42,
                        "evidence": {
                            "kind": "qwen_gguf",
                            "modelId": "qwen_gguf_q4",
                            "parsed": {
                                "tags": ["blue_room"],
                                "safety": "safe",
                                "rationale": "Original generated description.",
                            },
                            "raw": '{"tags":["blue_room"],"rationale":"Original generated description."}',
                        },
                    }
                ]
            },
        }

        saved = self.client.post(
            f"/api/posts/{post['id']}/ai-analysis",
            json={"suggestion": suggestion, "settings": settings, "profile": "test"},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        analysis_id = saved.json()["results"][0]["id"]

        updated = self.client.put(
            f"/api/posts/{post['id']}/ai-analysis/{analysis_id}",
            json={"description": "Edited violet lantern semantic description."},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["summary"], "Edited violet lantern semantic description.")
        self.assertEqual(updated.json()["rationale"], "Edited violet lantern semantic description.")

        self.client.put("/api/auto-tags/settings", json={"settings": settings})
        search = self.client.get("/api/posts", params={"q": "violet lantern"})
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(search.json()["total"], 1)
        self.assertEqual(search.json()["results"][0]["id"], post["id"])

    def test_autocomplete_prefers_word_boundary_prefix_over_compound_prefix(self):
        prefix = f"cowrank_{time.time_ns()}"
        boundary_tag = f"{prefix}_horns"
        compound_tag = f"{prefix}boy_shot"

        for _ in range(3):
            self._upload_image_post(tags=[compound_tag])
        self._upload_image_post(tags=[boundary_tag])

        response = self.client.get("/api/tags/autocomplete", params={"q": prefix, "limit": 10})

        self.assertEqual(response.status_code, 200, response.text)
        names = [tag["name"] for tag in response.json()]
        self.assertGreaterEqual(names.index(compound_tag), 1)
        self.assertEqual(names[0], boundary_tag)

    def test_post_search_matches_underscore_tag_parts_with_type_filter(self):
        suffix = f"partmatch_{time.time_ns()}"
        tag = f"{suffix}_final_fantasy"
        post = self._upload_image_post(tags=[tag])

        response = self.client.get("/api/posts", params={"q": f"type:image {suffix} final fantasy"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["total"], 1)
        self.assertEqual(response.json()["results"][0]["id"], post["id"])

    def test_tag_search_treats_spaces_as_underscores(self):
        suffix = f"tagspace_{time.time_ns()}"
        tag = f"{suffix}_large_breasts"
        self._upload_image_post(tags=[tag])

        response = self.client.get("/api/tags", params={"q": f"{suffix} large breasts"})

        self.assertEqual(response.status_code, 200, response.text)
        names = [item["name"] for item in response.json()["results"]]
        self.assertIn(tag, names)

    def test_autocomplete_matches_last_underscore_part(self):
        suffix = f"lockhart_{time.time_ns()}"
        tag = f"tifa_{suffix}"
        self._upload_image_post(tags=[tag])

        response = self.client.get("/api/tags/autocomplete", params={"q": suffix, "limit": 10})

        self.assertEqual(response.status_code, 200, response.text)
        names = [item["name"] for item in response.json()]
        self.assertIn(tag, names)


if __name__ == "__main__":
    unittest.main()
