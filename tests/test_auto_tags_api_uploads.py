import time
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_tag_support as support


class AutoTagUploadApiTests(support.AutoTagApiTestCase):
    """Upload and post-creation endpoints with auto-tagging around them: previews, tag metadata, duplicates, bulk edits."""

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
        # Flat test images all share one perceptual hash, so this neighbour is
        # a "similar post" whose tags must not leak in while tagging is off.
        self._upload_image_post(tags=["neighbour_tag"])
        post = self._upload_image_post(tags=["manual_tag"])

        preview = self.client.post(f"/api/posts/{post['id']}/auto-tags/preview")

        self.assertEqual(preview.status_code, 200, preview.text)
        body = preview.json()
        self.assertEqual(body["suggestedTags"], ["manual_tag"])
        self.assertEqual(body["suggestedSafety"], "safe")
        self.assertEqual(body["error"], "disabled")
        self.assertNotIn("auto_tagged", body["categories"])

    def test_create_post_honours_client_supplied_tag_metadata(self):
        """The extension imports a booru post's own artist/character split."""
        self._disable_auto_tags()
        token = self._upload_image_token()
        created = self.client.post(
            "/api/posts",
            json={
                "contentToken": token,
                "tags": ["1girl", "code_geass", "c.c.", "miyu_(blue_archive)"],
                "safety": "safe",
                "autoTag": False,
                "tagCategories": {
                    "code_geass": "copyright",
                    "c.c.": "character",
                    "miyu_(blue_archive)": "character",
                },
                # The qualifier spelling survives the name flattening.
                "tagDisplayNames": {"miyu_(blue_archive)": "miyu (blue archive)"},
            },
        )
        self.assertEqual(created.status_code, 200, created.text)

        detail = self.client.get(f"/api/posts/{created.json()['id']}")
        self.assertEqual(detail.status_code, 200, detail.text)
        by_name = {row["name"]: row for row in detail.json()["tagDetails"]}
        self.assertEqual(by_name["code_geass"]["category"], "copyright")
        self.assertEqual(by_name["c.c."]["category"], "character")
        self.assertEqual(by_name["miyu_blue_archive"]["category"], "character")
        self.assertEqual(by_name["miyu_blue_archive"]["displayName"], "miyu (blue archive)")
        # Anything the client said nothing about keeps the old default.
        self.assertEqual(by_name["1girl"]["category"], "general")

    def test_pending_upload_is_served_for_preview(self):
        """The popup can only preview yt-dlp media by asking the server for it."""
        from app.routers.uploads import remove_upload_token

        token = self._upload_image_token()
        try:
            response = self.client.get(f"/api/uploads/{token}/content")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["content-type"], "image/png")
            self.assertTrue(response.content)

            # Scrubbing a video needs range requests to work.
            ranged = self.client.get(f"/api/uploads/{token}/content", headers={"Range": "bytes=0-9"})
            self.assertEqual(ranged.status_code, 206, ranged.text)
            self.assertEqual(len(ranged.content), 10)
        finally:
            remove_upload_token(token)

    def test_unknown_upload_token_has_no_content(self):
        response = self.client.get("/api/uploads/not-a-token/content")
        self.assertEqual(response.status_code, 404, response.text)

    def test_user_category_exists_for_social_handles(self):
        response = self.client.get("/api/tag-categories")
        self.assertEqual(response.status_code, 200, response.text)
        names = [row["name"] for row in response.json()]
        self.assertIn("user", names)

        post = self.client.post(
            "/api/posts",
            json={
                "contentToken": self._upload_image_token(),
                "tags": ["twitter_user_someone"],
                "autoTag": False,
                "tagCategories": {"twitter_user_someone": "user"},
            },
        )
        self.assertEqual(post.status_code, 200, post.text)
        detail = self.client.get(f"/api/posts/{post.json()['id']}")
        by_name = {row["name"]: row for row in detail.json()["tagDetails"]}
        self.assertEqual(by_name["twitter_user_someone"]["category"], "user")

    def test_hand_typed_qualifier_tag_keeps_its_booru_spelling(self):
        """Typing evie_(stellar_blade) should read back with the parentheses."""
        self._disable_auto_tags()
        post = self._upload_image_post(tags=["evie_(stellar_blade)"])

        detail = self.client.get(f"/api/posts/{post['id']}")
        by_name = {row["name"]: row for row in detail.json()["tagDetails"]}
        self.assertIn("evie_stellar_blade", by_name)
        self.assertEqual(by_name["evie_stellar_blade"]["displayName"], "evie (stellar blade)")

        # Either spelling finds it, since both normalize to the stored name.
        for query in ("evie_(stellar_blade)", "evie_stellar_blade"):
            found = self.client.get("/api/posts", params={"q": query})
            self.assertEqual(found.status_code, 200, found.text)
            self.assertIn(post["id"], [row["id"] for row in found.json()["results"]], query)

    def test_create_post_without_tag_metadata_is_unchanged(self):
        self._disable_auto_tags()
        post = self._upload_image_post(tags=["plain_tag"])

        detail = self.client.get(f"/api/posts/{post['id']}")
        by_name = {row["name"]: row for row in detail.json()["tagDetails"]}
        self.assertEqual(by_name["plain_tag"]["category"], "general")
        # No stored spelling, so it falls back to the underscore-free name.
        self.assertEqual(by_name["plain_tag"]["displayName"], "plain tag")

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

    def test_bulk_preview_job_can_apply_saved_suggestions(self):
        self._enable_auto_tags()
        post = self._upload_image_post(tags=[], safety="safe")

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._fake_result()), \
                patch("app.services.auto_tag_jobs._model_unready", return_value=None):
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


if __name__ == "__main__":
    unittest.main()
