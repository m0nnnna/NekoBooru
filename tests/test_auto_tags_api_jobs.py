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


if __name__ == "__main__":
    unittest.main()
