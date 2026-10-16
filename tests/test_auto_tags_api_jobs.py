import time
import unittest
from unittest.mock import patch

import auto_tag_support as support


class AutoTagBulkJobApiTests(support.AutoTagApiTestCase):
    """Bulk library jobs: refusing to start without a runnable model, and never writing a post no model analysed."""

    def _wait_for_job(self, job_id):
        for _ in range(60):
            job = self.client.get(f"/api/auto-tags/jobs/{job_id}").json()
            if job["status"] not in {"queued", "running"}:
                return job
            time.sleep(0.05)
        self.fail(f"job {job_id} did not finish")

    def _start_job(self, post_ids, dry_run=False):
        return self.client.post(
            "/api/auto-tags/jobs",
            json={"mode": "selected", "dryRun": dry_run, "postIds": post_ids, "settings": {}},
        )

    def _failed_result(self):
        from app.services.auto_tagger import AutoTagResult

        # What dispatch returns when WD cannot run: an error, plus the media-type
        # tag post-processing appends regardless.
        return AutoTagResult(
            tags=["image"],
            categories={"image": "meta"},
            model="WD Tagger",
            error="WD Tagger: missing_runtime_dependency",
            enabled=True,
        )

    def test_job_refuses_to_start_when_no_enabled_model_can_run(self):
        self._enable_auto_tags()
        post = self._upload_image_post()

        with patch("app.services.auto_tag_jobs._model_unready", return_value="missing_runtime_dependency"):
            response = self._start_job([post["id"]])

        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("None of the enabled models can run", response.json()["detail"])

    def test_post_no_model_analysed_is_failed_and_left_untouched(self):
        self._enable_auto_tags()
        post = self._upload_image_post(tags=["kept_tag"], safety="unsafe")

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._failed_result()), \
                patch("app.services.auto_tag_jobs._model_unready", return_value=None):
            response = self._start_job([post["id"]])
            self.assertEqual(response.status_code, 200, response.text)
            job = self._wait_for_job(response.json()["id"])

        self.assertEqual((job["processed"], job["failed"], job["tagged"]), (1, 1, 0))
        self.assertIn("missing_runtime_dependency", job["error"])
        after = self.client.get(f"/api/posts/{post['id']}").json()
        self.assertEqual(after["tags"], ["kept_tag"])
        self.assertEqual(after["safety"], "unsafe")

    def test_job_stops_when_its_first_posts_all_fail(self):
        self._enable_auto_tags()
        posts = [self._upload_image_post() for _ in range(3)]

        with patch("app.services.auto_tag_jobs.tag_media", return_value=self._failed_result()), \
                patch("app.services.auto_tag_jobs._model_unready", return_value=None), \
                patch("app.services.auto_tag_jobs.EARLY_FAILURE_LIMIT", 2):
            response = self._start_job([p["id"] for p in posts])
            self.assertEqual(response.status_code, 200, response.text)
            job = self._wait_for_job(response.json()["id"])

        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["processed"], 2)
        self.assertIn("Stopped after the first 2 posts all failed", job["error"])

    def test_everything_turns_on_each_ready_model_and_every_write(self):
        from app.services.auto_tag_jobs import everything_overrides
        from app.services.auto_tagger import AutoTagOptions

        ready = {"wd", "cl", "ocr", "qwen_gguf_q4"}
        with patch("app.services.auto_tag_jobs._model_unready",
                   side_effect=lambda m: None if m in ready else "model_not_downloaded"):
            overrides = everything_overrides(AutoTagOptions(semanticModelId="qwen"))

        for key in ("wdEnabled", "clEnabled", "ocrEnabled", "qwenEnabled",
                    "applySafety", "inheritSimilarTags", "saveSemanticAnalysis", "enabled"):
            self.assertTrue(overrides.get(key), key)
        for key in ("pixaiEnabled", "characterModelEnabled", "whisperEnabled"):
            self.assertNotIn(key, overrides)
        # The selected Qwen backend is not downloaded, so a ready one runs instead.
        self.assertEqual(overrides["semanticModelId"], "qwen_gguf_q4")

    def test_everything_estimate_names_only_models_that_can_run(self):
        self._enable_auto_tags()
        with patch("app.services.auto_tag_jobs._model_unready", return_value="missing_runtime_dependency"):
            none_ready = self.client.get("/api/auto-tags/estimate?mode=everything").json()
        with patch("app.services.auto_tag_jobs._model_unready",
                   side_effect=lambda m: None if m in {"wd", "ocr"} else "model_not_downloaded"):
            some_ready = self.client.get("/api/auto-tags/estimate?mode=everything").json()

        # WD is on by default, but it must not be listed when it cannot run.
        self.assertEqual(none_ready["models"], [])
        self.assertEqual(some_ready["models"], ["WD Tagger", "TrOCR Printed"])

    def test_everything_job_adds_tags_and_rating_to_every_post_without_removing_any(self):
        self._enable_auto_tags()
        light = self._upload_image_post(tags=[], safety="unsafe")
        heavy = self._upload_image_post(tags=[f"kept_{i}" for i in range(6)] + ["red_eyes"], safety="safe")
        seen_opts = []

        def fake_tag_media(path, opts):
            seen_opts.append(opts)
            return self._fake_result()  # red_eyes, close-up, hatsune_miku; rated unsafe

        with patch("app.services.auto_tag_jobs.tag_media", side_effect=fake_tag_media), \
                patch("app.services.auto_tag_jobs._model_unready", return_value=None):
            response = self.client.post(
                "/api/auto-tags/jobs",
                json={"mode": "everything", "dryRun": False, "settings": {}},
            )
            self.assertEqual(response.status_code, 200, response.text)
            job = self._wait_for_job(response.json()["id"])

        self.assertEqual(job["status"], "completed", job)
        self.assertGreaterEqual(job["processed"], 2)  # heavily tagged posts are not filtered out
        self.assertTrue(all(o.wdEnabled and o.pixaiEnabled and o.qwenEnabled and o.applySafety for o in seen_opts))

        after = self.client.get(f"/api/posts/{heavy['id']}").json()
        for tag in [f"kept_{i}" for i in range(6)] + ["red_eyes", "hatsune_miku"]:
            self.assertIn(tag, after["tags"])
        self.assertEqual(after["tags"].count("red_eyes"), 1)
        self.assertEqual(after["safety"], "unsafe")
        self.assertEqual(self.client.get(f"/api/posts/{light['id']}").json()["safety"], "unsafe")


if __name__ == "__main__":
    unittest.main()
