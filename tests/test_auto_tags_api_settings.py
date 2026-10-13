import os
import unittest
import types
from pathlib import Path
from unittest.mock import patch

import auto_tag_support as support


class AutoTagSettingsApiTests(support.AutoTagApiTestCase):
    """Settings endpoints around auto-tagging: extension and AI model defaults, secrets, yt-dlp cookies."""

    def test_extension_upload_defaults_can_be_saved(self):
        default_response = self.client.get("/api/settings/extension")
        self.assertEqual(default_response.status_code, 200, default_response.text)
        defaults = default_response.json()
        # modelDefaults is the shared AI model stack, which other tests in this
        # class write; only the extension's own toggles have fixed defaults.
        self.assertIsInstance(defaults.pop("modelDefaults"), dict)
        self.assertEqual(
            defaults,
            {
                "saveTweetTag": True,
                "saveTweetUsername": False,
                "saveSourcePageUrl": True,
                "saveMediaUrl": False,
                "saveSemanticAnalysis": False,
            },
        )

        updated = self.client.put(
            "/api/settings/extension",
            json={
                "saveTweetTag": False,
                "saveTweetUsername": True,
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
                "saveTweetUsername": True,
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

    def test_gelbooru_credentials_lifecycle_does_not_echo_api_key(self):
        with patch.dict(os.environ, {"GELBOORU_USER_ID": "", "GELBOORU_API_KEY": ""}):
            response = self.client.delete("/api/auto-tags/gelbooru-credentials")
            self.assertEqual(response.status_code, 200, response.text)

            response = self.client.put(
                "/api/auto-tags/gelbooru-credentials",
                json={"userId": "9455", "apiKey": "gelbooru_test_secret"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["gelbooruCredentialsConfigured"])
            self.assertNotIn("gelbooru_test_secret", response.text)

            response = self.client.put(
                "/api/auto-tags/gelbooru-credentials",
                json={"userId": "not-a-number", "apiKey": "still_secret"},
            )
            self.assertEqual(response.status_code, 400, response.text)
            self.assertNotIn("still_secret", response.text)

            response = self.client.delete("/api/auto-tags/gelbooru-credentials")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(response.json()["gelbooruCredentialsConfigured"])

    def test_semantic_model_setting_validates_to_known_backend(self):
        from app.services.auto_tagger import validate_options

        self.assertEqual(validate_options({"semanticModelId": "qwen_gguf_q4"}).semanticModelId, "qwen_gguf_q4")
        self.assertEqual(validate_options({"semanticModelId": "qwen_gguf_q8"}).semanticModelId, "qwen_gguf_q8")
        self.assertEqual(validate_options({"semanticModelId": "bogus"}).semanticModelId, "qwen")


if __name__ == "__main__":
    unittest.main()
