import os
import json
import shutil
import sys
import tempfile
import time
import unittest
import asyncio
import types
from pathlib import Path
from unittest.mock import Mock, patch


class AutoTagApiTests(unittest.TestCase):
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
        tmp_root = Path(cls.tmp.name)
        os.environ["NEKO_CONFIG_DIR"] = str(tmp_root / "config")
        os.environ["NEKO_CONFIG_FILE"] = str(tmp_root / "config" / "settings.json")
        os.environ["NEKO_DATA_DIR"] = str(tmp_root / "data")
        os.environ["NEKO_LOGS_DIR"] = str(tmp_root / "logs")
        os.environ["NEKO_MODELS_DIR"] = str(tmp_root / "models")
        os.environ["NEKO_RUNTIMES_DIR"] = str(tmp_root / "runtimes")
        os.environ["NEKO_CACHE_DIR"] = str(tmp_root / "cache")
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

        from fastapi.testclient import TestClient
        from app.main import app

        cls.client = TestClient(app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        from app.database import engine

        asyncio.run(engine.dispose())
        for key, value in cls._previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.tmp.cleanup()

    def _upload_image_post(self, tags=None, safety="safe"):
        token = self._upload_image_token()
        created = self.client.post(
            "/api/posts",
            json={
                "contentToken": token,
                "tags": tags or [],
                "safety": safety,
                "autoTag": False,
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        return created.json()

    def _upload_image_token(self):
        from PIL import Image

        stamp = time.time_ns()
        image_path = Path(self.tmp.name) / f"sample-{stamp}.png"
        color = (stamp % 255, (stamp // 255) % 255, (stamp // 65025) % 255)
        Image.new("RGB", (32, 32), color).save(image_path)
        with image_path.open("rb") as fh:
            upload = self.client.post(
                "/api/uploads",
                files={"content": (image_path.name, fh, "image/png")},
            )
        self.assertEqual(upload.status_code, 200, upload.text)
        return upload.json()["token"]

    def _upload_specific_image_token(self, image_path):
        with image_path.open("rb") as fh:
            upload = self.client.post(
                "/api/uploads",
                files={"content": (image_path.name, fh, "image/png")},
            )
        self.assertEqual(upload.status_code, 200, upload.text)
        return upload.json()["token"]

    def _enable_auto_tags(self):
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["enabled"] = True
        settings["applySafety"] = True
        settings["addProvenanceTag"] = True
        response = self.client.put("/api/auto-tags/settings", json={"settings": settings})
        self.assertEqual(response.status_code, 200, response.text)

    def _disable_auto_tags(self):
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["enabled"] = False
        response = self.client.put("/api/auto-tags/settings", json={"settings": settings})
        self.assertEqual(response.status_code, 200, response.text)

    def _fake_result(self):
        from app.services.auto_tagger import AutoTagResult

        return AutoTagResult(
            tags=["red eyes", "close-up"],
            character_tags=["hatsune_miku"],
            rating={"explicit": 0.91, "questionable": 0.2},
            safety="unsafe",
            categories={
                "red_eyes": "general",
                "close-up": "general",
                "hatsune_miku": "character",
            },
            evidence={"kind": "image", "test": True},
            model="fake-wd",
            enabled=True,
        )

    def test_jfif_upload_is_normalized_to_jpg(self):
        from PIL import Image
        from app.routers.uploads import get_upload_path, remove_upload_token

        image_path = Path(self.tmp.name) / f"sample-{time.time_ns()}.jfif"
        Image.new("RGB", (32, 32), (120, 80, 200)).save(image_path, format="JPEG")

        with image_path.open("rb") as fh:
            upload = self.client.post(
                "/api/uploads",
                files={"content": (image_path.name, fh, "image/jpeg")},
            )

        self.assertEqual(upload.status_code, 200, upload.text)
        token = upload.json()["token"]
        temp_path = get_upload_path(token)
        try:
            self.assertIsNotNone(temp_path)
            self.assertEqual(temp_path.suffix, ".jpg")
            self.assertTrue(temp_path.exists())
        finally:
            if temp_path:
                temp_path.unlink(missing_ok=True)
            remove_upload_token(token)

    def test_disabled_preview_preserves_tags_without_provenance(self):
        self._disable_auto_tags()
        post = self._upload_image_post(tags=["manual_tag"])

        preview = self.client.post(f"/api/posts/{post['id']}/auto-tags/preview")

        self.assertEqual(preview.status_code, 200, preview.text)
        body = preview.json()
        self.assertEqual(body["suggestedTags"], ["manual_tag"])
        self.assertEqual(body["suggestedSafety"], "safe")
        self.assertEqual(body["error"], "disabled")
        self.assertNotIn("auto_tagged", body["categories"])

    def test_extension_upload_defaults_can_be_saved(self):
        default_response = self.client.get("/api/settings/extension")
        self.assertEqual(default_response.status_code, 200, default_response.text)
        self.assertEqual(
            default_response.json(),
            {
                "saveTweetTag": True,
                "saveSourcePageUrl": True,
                "saveMediaUrl": False,
                "saveSemanticAnalysis": False,
                "modelDefaults": {},
            },
        )

        updated = self.client.put(
            "/api/settings/extension",
            json={
                "saveTweetTag": False,
                "saveSourcePageUrl": False,
                "saveMediaUrl": True,
                "saveSemanticAnalysis": True,
                "modelDefaults": {
                    "wdEnabled": False,
                    "pixaiEnabled": True,
                    "characterModelEnabled": True,
                    "qwenEnabled": True,
                    "ocrEnabled": True,
                    "whisperEnabled": False,
                },
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(
            updated.json(),
            {
                "saveTweetTag": False,
                "saveSourcePageUrl": False,
                "saveMediaUrl": True,
                "saveSemanticAnalysis": True,
                "modelDefaults": {
                    "wdEnabled": False,
                    "pixaiEnabled": True,
                    "characterModelEnabled": True,
                    "qwenEnabled": True,
                    "semanticPoliticalEnabled": True,
                    "ocrEnabled": True,
                    "whisperEnabled": False,
                },
            },
        )

        loaded = self.client.get("/api/settings/extension")
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(loaded.json(), updated.json())

    def test_ai_model_defaults_are_shared_with_extension_compatibility(self):
        updated = self.client.put(
            "/api/settings/ai-model-defaults",
            json={
                "modelDefaults": {
                    "wdEnabled": True,
                    "pixaiEnabled": False,
                    "characterModelEnabled": True,
                    "qwenEnabled": False,
                    "ocrEnabled": True,
                    "whisperEnabled": True,
                }
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(
            updated.json()["modelDefaults"],
            {
                "wdEnabled": True,
                "pixaiEnabled": False,
                "characterModelEnabled": True,
                "qwenEnabled": False,
                "semanticPoliticalEnabled": False,
                "ocrEnabled": True,
                "whisperEnabled": True,
            },
        )

        loaded = self.client.get("/api/settings/ai-model-defaults")
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(loaded.json(), updated.json())

        extension = self.client.get("/api/settings/extension")
        self.assertEqual(extension.status_code, 200, extension.text)
        self.assertEqual(extension.json()["modelDefaults"], updated.json()["modelDefaults"])

    def test_ai_model_defaults_include_profile_specific_stacks(self):
        updated = self.client.put(
            "/api/settings/ai-model-defaults",
            json={
                "modelDefaults": {
                    "wdEnabled": True,
                    "pixaiEnabled": False,
                    "characterModelEnabled": False,
                    "qwenEnabled": False,
                    "profileDefaults": {
                        "anime": {
                            "wdEnabled": False,
                            "pixaiEnabled": True,
                            "characterModelEnabled": True,
                            "ocrEnabled": True,
                        },
                        "realistic": {
                            "wdEnabled": False,
                            "qwenEnabled": True,
                            "ocrEnabled": True,
                            "whisperEnabled": True,
                        },
                    },
                }
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        defaults = updated.json()["modelDefaults"]
        self.assertTrue(defaults["profileDefaults"]["anime"]["pixaiEnabled"])
        self.assertTrue(defaults["profileDefaults"]["anime"]["characterModelEnabled"])
        self.assertTrue(defaults["profileDefaults"]["realistic"]["qwenEnabled"])
        self.assertTrue(defaults["profileDefaults"]["realistic"]["semanticPoliticalEnabled"])

        extension = self.client.get("/api/settings/extension")
        self.assertEqual(extension.status_code, 200, extension.text)
        self.assertEqual(extension.json()["modelDefaults"], defaults)

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

    def test_duplicate_post_response_includes_existing_post_link_data(self):
        from PIL import Image

        stamp = time.time_ns()
        image_path = Path(self.tmp.name) / f"duplicate-{stamp}.png"
        color = (stamp % 255, (stamp // 255) % 255, (stamp // 65025) % 255)
        Image.new("RGB", (32, 32), color).save(image_path)

        first_token = self._upload_specific_image_token(image_path)
        created = self.client.post(
            "/api/posts",
            json={"contentToken": first_token, "tags": [], "safety": "safe", "autoTag": False},
        )
        self.assertEqual(created.status_code, 200, created.text)
        post = created.json()

        second_token = self._upload_specific_image_token(image_path)
        duplicate = self.client.post(
            "/api/posts",
            json={"contentToken": second_token, "tags": [], "safety": "safe", "autoTag": False},
        )

        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        detail = duplicate.json()["detail"]
        self.assertEqual(detail["code"], "duplicate_post")
        self.assertEqual(detail["postId"], post["id"])
        self.assertEqual(detail["postUrl"], f"/post/{post['id']}")
        self.assertEqual(detail["post"]["id"], post["id"])

    def test_duplicate_soft_deleted_post_does_not_leak_integrity_error(self):
        from PIL import Image

        stamp = time.time_ns()
        image_path = Path(self.tmp.name) / f"deleted-duplicate-{stamp}.png"
        color = (stamp % 255, (stamp // 255) % 255, (stamp // 65025) % 255)
        Image.new("RGB", (32, 32), color).save(image_path)

        first_token = self._upload_specific_image_token(image_path)
        created = self.client.post(
            "/api/posts",
            json={"contentToken": first_token, "tags": [], "safety": "safe", "autoTag": False},
        )
        self.assertEqual(created.status_code, 200, created.text)
        post = created.json()

        deleted = self.client.delete(f"/api/posts/{post['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.text)

        second_token = self._upload_specific_image_token(image_path)
        duplicate = self.client.post(
            "/api/posts",
            json={"contentToken": second_token, "tags": [], "safety": "safe", "autoTag": False},
        )

        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        detail = duplicate.json()["detail"]
        self.assertEqual(detail["code"], "duplicate_post")
        self.assertEqual(detail["postId"], post["id"])
        self.assertTrue(detail["deleted"])
        self.assertNotIn("sqlite", duplicate.text.lower())

        restored = self.client.post(f"/api/posts/{post['id']}/restore")
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertIsNone(restored.json()["deletedAt"])

        visible = self.client.get(f"/api/posts/{post['id']}")
        self.assertEqual(visible.status_code, 200, visible.text)

    def test_bulk_update_can_clear_tags_and_set_safety(self):
        first = self._upload_image_post(tags=["old_tag", "shared"], safety="safe")
        second = self._upload_image_post(tags=["another_tag", "shared"], safety="safe")

        response = self.client.post(
            "/api/posts/bulk-update",
            json={
                "postIds": [first["id"], second["id"]],
                "tagMode": "clear",
                "tags": [],
                "safety": "unsafe",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["updated"], 2)
        first_after = self.client.get(f"/api/posts/{first['id']}").json()
        second_after = self.client.get(f"/api/posts/{second['id']}").json()
        self.assertEqual(first_after["tags"], [])
        self.assertEqual(second_after["tags"], [])
        self.assertEqual(first_after["safety"], "unsafe")
        self.assertEqual(second_after["safety"], "unsafe")

    def test_per_post_apply_adds_tags_categories_and_promotes_unsafe(self):
        self._enable_auto_tags()
        post = self._upload_image_post(tags=["manual_tag"], safety="safe")

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._fake_result()):
            applied = self.client.post(f"/api/posts/{post['id']}/auto-tags/apply", json={})

        self.assertEqual(applied.status_code, 200, applied.text)
        body = applied.json()
        self.assertEqual(body["safety"], "unsafe")
        self.assertIn("manual_tag", body["tags"])
        self.assertIn("red_eyes", body["tags"])
        self.assertIn("hatsune_miku", body["tags"])
        self.assertIn("auto_tagged", body["tags"])

        tag = self.client.get("/api/tags/hatsune_miku")
        self.assertEqual(tag.status_code, 200, tag.text)
        self.assertEqual(tag.json()["category"], "character")

    def test_upload_token_preview_does_not_create_post(self):
        self._enable_auto_tags()
        token = self._upload_image_token()
        before_total = self.client.get("/api/posts").json()["total"]

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._fake_result()):
            preview = self.client.post(
                f"/api/uploads/{token}/auto-tags/preview",
                json={"tags": ["manual_tag"], "safety": "safe", "settings": {}},
            )

        self.assertEqual(preview.status_code, 200, preview.text)
        body = preview.json()
        self.assertIsNone(body["postId"])
        self.assertIn("manual_tag", body["suggestedTags"])
        self.assertIn("red_eyes", body["suggestedTags"])
        self.assertEqual(body["suggestedSafety"], "unsafe")
        self.assertEqual(self.client.get("/api/posts").json()["total"], before_total)

    def test_ytdlp_accepts_temporary_cookie_payload(self):
        import app.routers.uploads as uploads

        captured = {}
        real_import = __import__

        class FakeYoutubeDL:
            def __init__(self, opts):
                captured["cookiefile"] = opts.get("cookiefile")
                self.opts = opts

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def extract_info(self, url, download=False):
                return {"title": "locked video", "ext": "mp4"}

            def download(self, urls):
                Path(self.opts["outtmpl"].replace("%(ext)s", "mp4")).write_bytes(b"video")

        def fake_import(name, *args, **kwargs):
            if name == "yt_dlp":
                return types.SimpleNamespace(YoutubeDL=FakeYoutubeDL, version=types.SimpleNamespace(__version__="test"))
            return real_import(name, *args, **kwargs)

        cookies = "# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tsecret\n"
        with patch("builtins.__import__", side_effect=fake_import), patch("httpx.AsyncClient.head", side_effect=Exception):
            response = self.client.post(
                "/api/uploads/from-ytdlp",
                json={"url": "https://x.com/user/status/1", "cookies": cookies},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(captured["cookiefile"])
        self.assertFalse(Path(captured["cookiefile"]).exists())
        token = response.json()["token"]
        temp_path = uploads.get_upload_path(token)
        self.assertTrue(temp_path.exists())
        temp_path.unlink(missing_ok=True)
        uploads.remove_upload_token(token)

    def test_bulk_preview_job_can_apply_saved_suggestions(self):
        self._enable_auto_tags()
        post = self._upload_image_post(tags=[], safety="safe")

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._fake_result()):
            job_response = self.client.post(
                "/api/auto-tags/jobs",
                json={"mode": "selected", "dryRun": True, "postIds": [post["id"]], "settings": {}},
            )
            self.assertEqual(job_response.status_code, 200, job_response.text)
            job_id = job_response.json()["id"]
            for _ in range(20):
                job = self.client.get(f"/api/auto-tags/jobs/{job_id}").json()
                if job["status"] not in {"queued", "running"}:
                    break
                time.sleep(0.05)

        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["processed"], 1)
        self.assertEqual(job["tagged"], 1)

        unchanged = self.client.get(f"/api/posts/{post['id']}").json()
        self.assertEqual(unchanged["tags"], [])
        self.assertEqual(unchanged["safety"], "safe")

        apply_response = self.client.post(f"/api/auto-tags/jobs/{job_id}/apply")
        self.assertEqual(apply_response.status_code, 200, apply_response.text)
        self.assertEqual(apply_response.json()["applied"], 1)

        changed = self.client.get(f"/api/posts/{post['id']}").json()
        self.assertIn("red_eyes", changed["tags"])
        self.assertIn("hatsune_miku", changed["tags"])
        self.assertEqual(changed["safety"], "unsafe")

    def test_huggingface_token_lifecycle_does_not_echo_secret(self):
        with patch.dict(os.environ, {"HF_TOKEN": "", "HUGGINGFACE_HUB_TOKEN": ""}):
            response = self.client.delete("/api/auto-tags/huggingface-token")
            self.assertEqual(response.status_code, 200, response.text)

            response = self.client.put(
                "/api/auto-tags/huggingface-token",
                json={"token": "hf_test_secret"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["huggingFaceTokenConfigured"])
            self.assertNotIn("hf_test_secret", response.text)

            response = self.client.delete("/api/auto-tags/huggingface-token")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(response.json()["huggingFaceTokenConfigured"])

    def test_model_download_endpoint_reports_result(self):
        fake_result = {
            "model": "wd-eva02-large-tagger-v3",
            "modelId": "SmilingWolf/wd-eva02-large-tagger-v3",
            "downloaded": True,
            "loaded": False,
            "files": {
                "model.onnx": {"downloaded": True, "path": "model.onnx"},
                "selected_tags.csv": {"downloaded": True, "path": "selected_tags.csv"},
            },
            "huggingFaceTokenConfigured": False,
        }
        with patch("app.routers.auto_tags.download_model", return_value=fake_result):
            response = self.client.post("/api/auto-tags/model/download")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["downloaded"])
        self.assertEqual(response.json()["modelId"], "SmilingWolf/wd-eva02-large-tagger-v3")

    def test_concurrent_infer_requests_serialize_without_blocking_the_api(self):
        """Several extension popups tagging at once must queue, not collide."""
        import threading
        from PIL import Image
        from app.services import auto_tagger

        state = {"concurrent": 0, "peak": 0}
        counter_lock = threading.Lock()

        def fake_pipeline(path, opts):
            with counter_lock:
                state["concurrent"] += 1
                state["peak"] = max(state["peak"], state["concurrent"])
            time.sleep(0.15)
            with counter_lock:
                state["concurrent"] -= 1
            return auto_tagger.AutoTagResult(enabled=True, model="fake", tags=["x"])

        sample = Path(self.tmp.name) / "concurrent.png"
        Image.new("RGB", (8, 8), "white").save(sample)
        payload = sample.read_bytes()
        results = {}

        def worker(index):
            response = self.client.post(
                "/api/auto-tags/infer",
                files={"file": ("concurrent.png", payload, "image/png")},
                data={"options": "{}"},
            )
            results[index] = response.status_code

        with patch.object(auto_tagger, "_infer_local_locked", fake_pipeline):
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
            for thread in threads:
                thread.start()
            time.sleep(0.2)
            # The API must still answer while inference is saturated; running the
            # pipeline inline in an async endpoint used to block the event loop.
            probe = self.client.get("/api/auto-tags/models/load-job")
            for thread in threads:
                thread.join(timeout=15)

        self.assertEqual(set(results.values()), {200})
        self.assertEqual(probe.status_code, 200)
        self.assertEqual(state["peak"], 1, "inference must not run concurrently")

    def test_model_catalog_lists_downloadable_models(self):
        response = self.client.get("/api/auto-tags/models")

        self.assertEqual(response.status_code, 200, response.text)
        ids = {model["id"] for model in response.json()["models"]}
        self.assertIn("wd", ids)
        self.assertIn("pixai", ids)
        self.assertIn("camie", ids)
        self.assertIn("cl", ids)
        self.assertIn("qwen", ids)
        self.assertIn("qwen_gguf_q4", ids)
        self.assertIn("qwen_gguf_q8", ids)
        self.assertIn("ocr", ids)
        self.assertIn("whisper", ids)
        by_id = {model["id"]: model for model in response.json()["models"]}
        self.assertIn("downloadSize", by_id["qwen"])
        self.assertIn("vramRequirement", by_id["qwen"])
        self.assertIn("loaded", by_id["wd"])
        self.assertEqual(by_id["qwen_gguf_q4"]["backend"], "gguf")
        self.assertEqual(by_id["qwen_gguf_q8"]["quantization"], "Q8_0")

    def test_semantic_model_setting_validates_to_known_backend(self):
        from app.services.auto_tagger import validate_options

        self.assertEqual(validate_options({"semanticModelId": "qwen_gguf_q4"}).semanticModelId, "qwen_gguf_q4")
        self.assertEqual(validate_options({"semanticModelId": "qwen_gguf_q8"}).semanticModelId, "qwen_gguf_q8")
        self.assertEqual(validate_options({"semanticModelId": "bogus"}).semanticModelId, "qwen")

    def test_model_download_routes_start_background_jobs(self):
        fake_job = {
            "id": "job-1",
            "status": "queued",
            "modelIds": ["wd"],
            "models": {},
        }

        with patch("app.routers.auto_tags.start_model_download", return_value=fake_job) as start:
            response = self.client.post("/api/auto-tags/models/wd/download")
        self.assertEqual(response.status_code, 200, response.text)
        start.assert_called_once_with(["wd"])

        with patch("app.routers.auto_tags.start_model_download", return_value=fake_job) as start:
            response = self.client.post("/api/auto-tags/models/download-all")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(start.call_count, 1)
        self.assertIn("wd", start.call_args.args[0])
        self.assertIn("camie", start.call_args.args[0])
        self.assertIn("pixai", start.call_args.args[0])
        # CL Tagger is gated and 2.3 GB, so it is opt-in rather than part of "download all".
        self.assertNotIn("cl", start.call_args.args[0])

    def test_download_all_uses_selected_semantic_backend_only(self):
        fake_job = {
            "id": "job-gguf",
            "status": "queued",
            "modelIds": ["qwen_gguf_q4"],
            "models": {},
        }
        settings = self.client.get("/api/auto-tags/settings").json()
        settings["semanticModelId"] = "qwen_gguf_q4"
        response = self.client.put("/api/auto-tags/settings", json={"settings": settings})
        self.assertEqual(response.status_code, 200, response.text)

        try:
            with patch("app.routers.auto_tags.start_model_download", return_value=fake_job) as start:
                response = self.client.post("/api/auto-tags/models/download-all")

            self.assertEqual(response.status_code, 200, response.text)
            model_ids = start.call_args.args[0]
            self.assertIn("qwen_gguf_q4", model_ids)
            self.assertNotIn("qwen", model_ids)
            self.assertNotIn("qwen_gguf_q8", model_ids)
        finally:
            settings["semanticModelId"] = "qwen"
            self.client.put("/api/auto-tags/settings", json={"settings": settings})

    def test_model_download_cancel_route_cancels_active_job(self):
        fake_job = {
            "id": "job-1",
            "status": "cancelling",
            "modelIds": ["ocr"],
            "models": {
                "ocr": {
                    "id": "ocr",
                    "status": "cancelling",
                    "bytesDownloaded": 10,
                    "bytesTotal": 100,
                },
            },
        }

        with patch("app.routers.auto_tags.cancel_model_download", return_value=fake_job) as cancel:
            response = self.client.post("/api/auto-tags/models/download-job/cancel")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "cancelling")
        cancel.assert_called_once_with()

    def test_model_download_cancel_marks_queued_models_cancelled(self):
        from app.services import auto_tagger
        from app.services.auto_tagger import cancel_model_download, current_download_job

        now = time.time()
        with auto_tagger._download_lock:
            previous_job = auto_tagger._download_job
            auto_tagger._download_job = {
                "id": "job-cancel",
                "status": "running",
                "cancelRequested": False,
                "modelIds": ["ocr", "whisper"],
                "total": 2,
                "completed": 0,
                "failed": 0,
                "error": None,
                "createdAt": now,
                "updatedAt": now,
                "models": {
                    "ocr": {
                        "id": "ocr",
                        "name": "TrOCR Printed",
                        "repoId": "microsoft/trocr-base-printed",
                        "status": "queued",
                        "current": "",
                        "updatedAt": now,
                    },
                    "whisper": {
                        "id": "whisper",
                        "name": "Whisper Small",
                        "repoId": "openai/whisper-small",
                        "status": "queued",
                        "current": "",
                        "updatedAt": now,
                    },
                },
            }

        try:
            cancelled = cancel_model_download()
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual(cancelled["models"]["ocr"]["status"], "cancelled")
            self.assertEqual(cancelled["models"]["whisper"]["status"], "cancelled")
            self.assertEqual(current_download_job()["status"], "cancelled")
        finally:
            with auto_tagger._download_lock:
                auto_tagger._download_job = previous_job

    def test_model_load_route_starts_prewarm_job(self):
        fake_job = {
            "id": "load-1",
            "status": "queued",
            "modelId": "wd",
            "progress": 0,
        }
        with patch("app.routers.auto_tags.start_model_load", return_value=fake_job) as start:
            response = self.client.post("/api/auto-tags/models/wd/load")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "load-1")
        start.assert_called_once_with("wd")

    def test_model_unload_route_unloads_model(self):
        fake_result = {
            "modelId": "wd",
            "model": "WD Tagger",
            "unloaded": True,
            "loaded": False,
            "models": [],
        }
        with patch("app.routers.auto_tags.unload_model", return_value=fake_result) as unload:
            response = self.client.post("/api/auto-tags/models/wd/unload")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["loaded"])
        unload.assert_called_once_with("wd")

    def test_runtime_restart_route_reports_unavailable_without_handler(self):
        from app.services.app_restart import clear_restart_handler

        clear_restart_handler()
        status = self.client.get("/api/runtime/status")
        self.assertEqual(status.status_code, 200, status.text)
        self.assertFalse(status.json()["restart"]["available"])

        response = self.client.post("/api/runtime/restart")
        self.assertEqual(response.status_code, 409)

    def test_runtime_restart_route_invokes_registered_handler(self):
        from app.services.app_restart import clear_restart_handler, register_restart_handler

        try:
            register_restart_handler(lambda: {"status": "restarting", "message": "ok"})
            response = self.client.post("/api/runtime/restart")

            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], "restarting")
        finally:
            clear_restart_handler()

    def test_delete_model_cache_removes_snapshot_models(self):
        from app.services import auto_tagger
        from app.services.auto_tagger import delete_model_cache, model_cache_status

        repo_cache = (
            Path(self.tmp.name)
            / "models"
            / "huggingface"
            / "hub"
            / "models--Camais03--camie-tagger-v2"
        )
        snapshot = repo_cache / "snapshots" / "abc123"
        snapshot.mkdir(parents=True, exist_ok=True)
        (snapshot / "camie-tagger-v2.onnx").write_bytes(b"fake")
        (snapshot / "camie-tagger-v2-metadata.json").write_text("{}", encoding="utf-8")
        (repo_cache / "blobs").mkdir(exist_ok=True)
        (repo_cache / "blobs" / "partial.incomplete").write_bytes(b"partial")

        with patch.object(auto_tagger.settings, "models_dir", Path(self.tmp.name) / "models"):
            self.assertTrue(model_cache_status("camie")["downloaded"])
            result = delete_model_cache("camie")
            camie_status = next(model for model in result["models"] if model["id"] == "camie")
            self.assertTrue(result["deleted"])
            self.assertFalse(camie_status["downloaded"])
            self.assertFalse(repo_cache.exists())


class AutoTagUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def test_video_timestamp_strategy_samples_middle_when_single_frame(self):
        from app.services.auto_tagger import AutoTagOptions, _timestamps

        self.assertEqual(_timestamps(6.0, AutoTagOptions(videoMaxFrames=1)), [3.0])

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

    def test_twitter_media_url_normalizes_to_original_variant(self):
        from app.routers.uploads import _normalize_fetch_url

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

    def test_wd_can_be_disabled_for_per_run_overrides(self):
        from app.services.auto_tagger import AutoTagOptions, _tag_image

        with patch("app.services.auto_tagger._wd_tagger.tag_image") as wd_tag:
            result = _tag_image(Path("sample.png"), AutoTagOptions(wdEnabled=False))

        wd_tag.assert_not_called()
        self.assertEqual(result.error, "no_models_enabled")

    def test_missing_selected_model_returns_structured_error_without_loading(self):
        from app.services.auto_tagger import AutoTagOptions, _tag_image

        with patch("app.services.auto_tagger.runtime_available", return_value=True), \
             patch("app.services.auto_tagger.model_cache_status", return_value={"downloaded": False, "files": {}}), \
             patch("app.services.auto_tagger._camie_tagger.tag_image") as camie_tag:
            result = _tag_image(Path("sample.png"), AutoTagOptions(wdEnabled=False, characterModelEnabled=True))

        camie_tag.assert_not_called()
        self.assertEqual(result.error, "Camie Tagger v2: model_not_downloaded")
        self.assertEqual(result.evidence["models"][0]["evidence"]["action"], "download_model")

    def test_missing_pixai_model_returns_structured_error_without_loading(self):
        from app.services.auto_tagger import AutoTagOptions, _tag_image

        with patch("app.services.auto_tagger.runtime_available", return_value=True), \
             patch("app.services.auto_tagger.model_cache_status", return_value={"downloaded": False, "files": {}}), \
             patch("app.services.auto_tagger._pixai_tagger.tag_image") as pixai_tag:
            result = _tag_image(Path("sample.png"), AutoTagOptions(wdEnabled=False, pixaiEnabled=True))

        pixai_tag.assert_not_called()
        self.assertEqual(result.error, "PixAI Tagger v0.9: model_not_downloaded")
        self.assertEqual(result.evidence["models"][0]["evidence"]["action"], "download_model")

    def test_download_requests_queue_onto_a_running_job(self):
        import threading
        from app.services import auto_tagger

        release = threading.Event()
        repos = []

        def fake_snapshot_download(**kwargs):
            repos.append(kwargs["repo_id"])
            release.wait(timeout=10)
            return "/fake"

        auto_tagger._download_job = None
        try:
            # downloaded=False keeps the reconciler from completing rows early.
            with patch("huggingface_hub.snapshot_download", fake_snapshot_download),                  patch.object(auto_tagger, "model_cache_status", return_value={"downloaded": False, "files": {}}):
                first = auto_tagger.start_model_download(["wd"])
                for _ in range(100):
                    if repos:
                        break
                    time.sleep(0.05)

                queued = auto_tagger.start_model_download(["camie", "pixai"])
                self.assertEqual(queued["id"], first["id"])
                self.assertEqual(queued["queued"], ["camie", "pixai"])
                self.assertEqual(queued["total"], 3)

                # Asking for something already queued must not duplicate it.
                self.assertEqual(auto_tagger.start_model_download(["camie"])["queued"], [])

                release.set()
                for _ in range(200):
                    job = auto_tagger.current_download_job()
                    if job["status"] in {"completed", "failed"}:
                        break
                    time.sleep(0.05)

            job = auto_tagger.current_download_job()
            self.assertEqual(job["status"], "completed")
            self.assertEqual(job["completed"], 3)
            self.assertEqual(len(repos), 3)
        finally:
            release.set()
            auto_tagger._download_job = None

    def test_second_model_load_queues_instead_of_returning_the_running_job(self):
        import threading
        from app.services import auto_tagger

        gate = threading.Event()
        order = []

        class FakeTagger:
            def __init__(self, name):
                self.name = name
                self._loaded = False

            def is_loaded(self):
                return self._loaded

            def ensure_loaded(self, *args, **kwargs):
                gate.wait(timeout=10)
                self._loaded = True
                order.append(self.name)
                return True

        fakes = {"wd": FakeTagger("wd"), "camie": FakeTagger("camie")}
        auto_tagger._load_job = None
        auto_tagger._load_queue.clear()
        auto_tagger._load_worker = None
        try:
            with patch.object(auto_tagger, "_tagger_for_model", lambda mid: fakes[mid]),                  patch.object(auto_tagger, "_wd_tagger", fakes["wd"]):
                auto_tagger.start_model_load("wd")
                for _ in range(100):
                    if auto_tagger.current_model_load_job().get("modelId") == "wd":
                        break
                    time.sleep(0.05)

                # Used to hand back the in-flight wd job, so camie never loaded
                # and the UI polled a load that was never going to happen.
                second = auto_tagger.start_model_load("camie")
                self.assertEqual(second["modelId"], "wd")
                self.assertEqual(second["queued"], ["camie"])

                gate.set()
                for _ in range(200):
                    job = auto_tagger.current_model_load_job()
                    if not job["queued"] and job.get("modelId") == "camie" and job["status"] == "completed":
                        break
                    time.sleep(0.05)

            self.assertEqual(order, ["wd", "camie"])
        finally:
            gate.set()
            auto_tagger._load_job = None
            auto_tagger._load_queue.clear()

    def test_model_load_waits_for_in_flight_inference(self):
        import threading
        from app.services import auto_tagger

        events = []
        inference_started = threading.Event()
        finish_inference = threading.Event()

        def slow_infer(path, opts):
            events.append("infer:start")
            inference_started.set()
            finish_inference.wait(timeout=10)
            events.append("infer:end")
            return auto_tagger.AutoTagResult(enabled=True, model="fake")

        class FakeTagger:
            _loaded = False

            def is_loaded(self):
                return self._loaded

            def ensure_loaded(self, *args, **kwargs):
                events.append("load:start")
                self._loaded = True
                return True

        auto_tagger._load_job = None
        auto_tagger._load_queue.clear()
        auto_tagger._load_worker = None
        try:
            # Patch the inner function: _infer_local itself now takes the GPU lock.
            with patch.object(auto_tagger, "_infer_local_locked", slow_infer), \
                 patch.object(auto_tagger, "_tagger_for_model", lambda mid: FakeTagger()):
                tag_thread = threading.Thread(
                    target=auto_tagger.tag_media,
                    args=(Path("sample.png"), auto_tagger.AutoTagOptions(enabled=True)),
                    daemon=True,
                )
                tag_thread.start()
                self.assertTrue(inference_started.wait(timeout=5))

                auto_tagger.start_model_load("camie")
                time.sleep(0.3)
                # Loading a second model mid-inference is what used to OOM the process.
                self.assertEqual(events, ["infer:start"])

                finish_inference.set()
                tag_thread.join(timeout=5)
                for _ in range(100):
                    if "load:start" in events:
                        break
                    time.sleep(0.05)

            self.assertEqual(events, ["infer:start", "infer:end", "load:start"])
        finally:
            finish_inference.set()
            auto_tagger._load_job = None
            auto_tagger._load_queue.clear()

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

    def test_onnx_cuda_preload_is_idempotent_and_optional(self):
        from app.services import auto_tagger

        original = list(auto_tagger._ONNX_PRELOAD_HANDLES)
        try:
            # Without torch there is nothing to preload; ONNX must still fall
            # back to CPU rather than raising.
            auto_tagger._ONNX_PRELOAD_HANDLES.clear()
            auto_tagger._ONNX_CUDA_PREPARED = False
            with patch("app.services.auto_tagger.find_spec", return_value=None):
                auto_tagger._prepare_onnx_cuda_runtime()
            self.assertEqual(auto_tagger._ONNX_PRELOAD_HANDLES, [])

            # Repeat calls must not reload the libraries on every session.
            auto_tagger._ONNX_CUDA_PREPARED = False
            with patch("app.services.auto_tagger.find_spec", return_value=None):
                auto_tagger._prepare_onnx_cuda_runtime()
                auto_tagger._prepare_onnx_cuda_runtime()
            self.assertTrue(auto_tagger._ONNX_CUDA_PREPARED)
        finally:
            auto_tagger._ONNX_PRELOAD_HANDLES[:] = original
            auto_tagger._ONNX_CUDA_PREPARED = True

    def test_missing_cl_model_returns_structured_error_without_loading(self):
        from app.services.auto_tagger import AutoTagOptions, _tag_image

        with patch("app.services.auto_tagger.runtime_available", return_value=True),              patch("app.services.auto_tagger.model_cache_status", return_value={"downloaded": False, "files": {}}),              patch("app.services.auto_tagger._cl_tagger.tag_image") as cl_tag:
            result = _tag_image(Path("sample.png"), AutoTagOptions(wdEnabled=False, clEnabled=True))

        cl_tag.assert_not_called()
        self.assertEqual(result.error, "CL Tagger v2: model_not_downloaded")
        self.assertEqual(result.evidence["models"][0]["evidence"]["action"], "download_model")

    def test_cl_tagger_splits_categories_and_enforces_threshold_floor(self):
        import tempfile
        from PIL import Image
        import numpy as np
        from app.services.auto_tagger import AutoTagOptions, ClTagger

        class FakeInput:
            name = "pixel_values"
            shape = [1, 3, 384, 384]

        class FakeSession:
            def get_inputs(self):
                return [FakeInput()]

            def run(self, *_args, **_kwargs):
                # logits -> sigmoid: 0.88, 0.55, 0.98, 0.98, 0.98, 0.98
                return [np.asarray([[2.0, 0.2, 4.0, 4.0, 4.0, 4.0]], dtype=np.float32)]

        tagger = ClTagger()
        tagger._loaded = True
        tagger._session = FakeSession()
        tagger._idx_to_tag = {
            0: "blue_eyes",
            1: "weak_general",
            2: "hatsune_miku",
            3: "vocaloid",
            4: "explicit",
            5: "best quality",
        }
        tagger._tag_to_category = {
            "blue_eyes": "general",
            "weak_general": "general",
            "hatsune_miku": "character",
            "vocaloid": "copyright",
            "explicit": "rating",
            "best quality": "quality",
        }

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.png"
            Image.new("RGB", (32, 48), "white").save(path)
            result = tagger.tag_image(path, AutoTagOptions(generalThreshold=0.35, characterThreshold=0.45))

        self.assertIn("blue_eyes", result.tags)
        # 0.55 floor overrides the lower app-wide general threshold.
        self.assertNotIn("weak_general", result.tags)
        self.assertEqual(result.character_tags, ["hatsune_miku"])
        self.assertEqual(result.copyright_tags, ["vocaloid"])
        self.assertNotIn("best_quality", result.tags)
        self.assertEqual(result.safety, "unsafe")
        self.assertEqual(result.evidence["kind"], "cl")

    def test_cl_vocabulary_reader_handles_version_prefixed_keys(self):
        import tempfile
        from app.services.auto_tagger import _read_cl_vocabulary

        payload = {
            "v2_01a/idx_to_tag": {"0": "blue_eyes", "1": "explicit", "2": "worst quality"},
            "v2_01a/tag_to_category": {
                "blue_eyes": "General",
                # Older exports file the rating/quality words under General.
                "explicit": "General",
                "worst quality": "General",
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model_vocabulary.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            idx_to_tag, tag_to_category = _read_cl_vocabulary(path)

        self.assertEqual(idx_to_tag[0], "blue_eyes")
        self.assertEqual(tag_to_category["blue_eyes"], "general")
        self.assertEqual(tag_to_category["explicit"], "rating")
        self.assertEqual(tag_to_category["worst quality"], "quality")

    def test_pixai_keeps_character_threshold_conservative(self):
        import tempfile
        from PIL import Image
        import numpy as np
        from app.services.auto_tagger import AutoTagOptions, PixAiTagger

        class FakeInput:
            name = "input"
            shape = [1, 448, 448, 3]

        class FakeSession:
            def get_inputs(self):
                return [FakeInput()]

            def run(self, *_args, **_kwargs):
                return [np.asarray([[0.90, 0.60, 0.86]], dtype=np.float32)]

        tagger = PixAiTagger()
        tagger._loaded = True
        tagger._session = FakeSession()
        tagger._tag_rows = [
            ("blue_eyes", "general"),
            ("false_character", "character"),
            ("likely_character", "character"),
        ]

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.png"
            Image.new("RGB", (32, 32), "white").save(path)
            result = tagger.tag_image(path, AutoTagOptions(generalThreshold=0.35, characterThreshold=0.45))

        self.assertIn("blue_eyes", result.tags)
        self.assertNotIn("false_character", result.character_tags)
        self.assertIn("likely_character", result.character_tags)

    def test_snapshot_model_status_uses_local_snapshot_without_snapshot_download(self):
        import tempfile
        from app.services import auto_tagger

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "huggingface" / "hub" / "models--openai--whisper-small" / "snapshots" / "abc"
            snapshot.mkdir(parents=True)
            (snapshot / "config.json").write_text("{}", encoding="utf-8")

            with patch.object(auto_tagger.settings, "models_dir", root), \
                 patch("app.services.auto_tagger.find_spec", return_value=True), \
                 patch("app.services.auto_tagger.huggingface_token", return_value=None), \
                 patch("huggingface_hub.hf_hub_download"):
                status = auto_tagger.model_cache_status("whisper")

        self.assertTrue(status["downloaded"])

    def test_qwen_load_job_uses_longer_estimate(self):
        from app.services.auto_tagger import _new_load_job

        job = _new_load_job("qwen", status="queued", progress=0, message="Queued")

        self.assertGreaterEqual(job["estimatedSeconds"], 90)

    def test_torch_device_setting_validates_to_auto(self):
        from app.services.auto_tagger import validate_options

        opts = validate_options({"torchDevice": "space_laser"})

        self.assertEqual(opts.torchDevice, "auto")

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

    def test_qwen_device_map_respects_cpu_and_gpu_availability(self):
        from app.services.auto_tagger import _qwen_device_map

        self.assertEqual(_qwen_device_map("cpu"), "cpu")
        with patch("app.services.auto_tagger._torch_runtime_info", return_value={"cudaAvailable": False}):
            self.assertEqual(_qwen_device_map("auto"), "cpu")
            with self.assertRaises(RuntimeError):
                _qwen_device_map("gpu")
        with patch("app.services.auto_tagger._torch_runtime_info", return_value={"cudaAvailable": True}), \
             patch("app.services.auto_tagger._ensure_qwen_gpu_headroom") as headroom:
            self.assertEqual(_qwen_device_map("auto"), {"": 0})
            headroom.assert_called_once()

    def test_qwen_gpu_headroom_blocks_low_free_vram(self):
        from app.services.auto_tagger import _ensure_qwen_gpu_headroom

        with patch("app.services.auto_tagger._qwen_gpu_memory_info", return_value={"freeGb": 2.0, "totalGb": 24.0}):
            with self.assertRaisesRegex(RuntimeError, "free VRAM"):
                _ensure_qwen_gpu_headroom()

    def test_onnx_providers_prefer_cuda_with_cpu_fallback(self):
        from app.services.auto_tagger import _onnx_providers

        class Ort:
            @staticmethod
            def get_available_providers():
                return ["CUDAExecutionProvider", "CPUExecutionProvider"]

        self.assertEqual(_onnx_providers(Ort), ["CUDAExecutionProvider", "CPUExecutionProvider"])

    def test_onnx_session_retries_cpu_when_gpu_provider_fails(self):
        from app.services.auto_tagger import _create_onnx_session

        class Session:
            def __init__(self, providers):
                self.providers = providers

        class Ort:
            calls = []

            @staticmethod
            def get_available_providers():
                return ["CUDAExecutionProvider", "CPUExecutionProvider"]

            @staticmethod
            def InferenceSession(path, providers):
                Ort.calls.append(providers)
                if providers[0] == "CUDAExecutionProvider":
                    raise RuntimeError("DLL initialization routine failed")
                return Session(providers)

        session = _create_onnx_session(Ort, "model.onnx")

        self.assertEqual(session.providers, ["CPUExecutionProvider"])
        self.assertEqual(Ort.calls, [["CUDAExecutionProvider", "CPUExecutionProvider"], ["CPUExecutionProvider"]])

    def test_onnx_runtime_info_marks_import_failure_unavailable(self):
        from app.services.auto_tagger import _onnx_runtime_info

        with patch("app.services.auto_tagger.find_spec", return_value=True), \
             patch.dict("sys.modules", {"onnxruntime": None}):
            info = _onnx_runtime_info()

        self.assertFalse(info["available"])
        self.assertIn("error", info)

    def test_whisper_audio_seconds_is_capped_to_model_window(self):
        from app.services.auto_tagger import AutoTagOptions, _whisper_audio_seconds

        self.assertEqual(_whisper_audio_seconds(AutoTagOptions(videoMaxDurationSeconds=900)), 30)
        self.assertEqual(_whisper_audio_seconds(AutoTagOptions(videoMaxDurationSeconds=12)), 12)

    def test_whisper_transcribe_uses_short_audio_window(self):
        from app.services.auto_tagger import AutoTagOptions, _whisper_tagger

        old_pipeline = _whisper_tagger._pipeline
        old_loaded = _whisper_tagger._loaded
        pipeline = Mock(return_value={"text": "vote campaign"})
        _whisper_tagger._pipeline = pipeline
        _whisper_tagger._loaded = True
        try:
            with patch("app.services.auto_tagger._extract_audio", return_value=True) as extract_audio:
                result = _whisper_tagger.transcribe_video(Path("sample.mp4"), AutoTagOptions(videoMaxDurationSeconds=900))
        finally:
            _whisper_tagger._pipeline = old_pipeline
            _whisper_tagger._loaded = old_loaded

        extract_audio.assert_called_once()
        self.assertEqual(extract_audio.call_args.args[2], 30)
        pipeline.assert_called_once_with(str(extract_audio.call_args.args[1]), return_timestamps=False)
        self.assertIn("has_speech", result.tags)
        self.assertIn("political_audio", result.tags)

    def test_tag_media_async_offloads_blocking_work(self):
        from app.services.auto_tag_jobs import _tag_media_async
        from app.services.auto_tagger import AutoTagOptions, AutoTagResult

        expected = AutoTagResult(tags=["offloaded"], enabled=True)
        with patch("app.services.auto_tag_jobs.asyncio.to_thread", return_value=expected) as to_thread:
            result = asyncio.run(_tag_media_async(Path("sample.png"), AutoTagOptions()))

        self.assertIs(result, expected)
        self.assertEqual(to_thread.call_args.args[0].__name__, "tag_media")


if __name__ == "__main__":
    unittest.main()
