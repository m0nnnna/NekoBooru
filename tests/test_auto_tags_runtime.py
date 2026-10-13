import json
import tempfile
import time
import unittest
import asyncio
from pathlib import Path
from unittest.mock import Mock, patch

import auto_tag_support as support


class AutoTagRuntimeTests(unittest.TestCase):
    """Model dispatch, the download and load queues, ONNX/CUDA/torch runtime handling, and the taggers themselves."""

    @classmethod
    def setUpClass(cls):
        support.add_backend_path()

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

    def test_cuda_context_faults_are_recognised(self):
        from app.services.auto_tagger import _is_cuda_context_fatal

        # The messages a poisoned CUDA context actually produces: the original
        # cuDNN fault, then cublasCreate failing for everything after it.
        self.assertTrue(_is_cuda_context_fatal(RuntimeError(
            "CUBLAS failure 1: the library was not initialized ; GPU=0 ; expr=cublasCreate(&cublas_handle_);"
        )))
        self.assertTrue(_is_cuda_context_fatal(RuntimeError(
            "CUDNN_FE failure 11: CUDNN_BACKEND_API_FAILED ; GPU=0 ;"
        )))
        self.assertTrue(_is_cuda_context_fatal(RuntimeError("CUDA failure 999: unknown error")))
        self.assertFalse(_is_cuda_context_fatal(RuntimeError("CL Tagger model files are not downloaded")))

    def test_fatal_cuda_error_rebuilds_the_tagger_on_cpu(self):
        from app.services import auto_tagger
        from app.services.auto_tagger import AutoTagResult

        calls = []

        def flaky():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError(
                    "CUBLAS failure 1: the library was not initialized ; expr=cublasCreate(&cublas_handle_);"
                )
            return AutoTagResult(enabled=True, tags=["1girl"])

        with patch.object(auto_tagger, "_ONNX_CUDA_DISABLED", False),                 patch.object(auto_tagger, "_ONNX_CPU_REBUILT", set()),                 patch.object(auto_tagger._cl_tagger, "unload", Mock(return_value=False)):
            result = auto_tagger._run_optional("cl", flaky)
            self.assertTrue(auto_tagger._ONNX_CUDA_DISABLED)

        # The GPU attempt failed; the CPU rebuild produced tags instead of an error.
        self.assertEqual(len(calls), 2)
        self.assertIsNone(result.error)
        self.assertEqual(result.tags, ["1girl"])

    def test_cpu_rebuild_is_attempted_once_per_model(self):
        from app.services import auto_tagger

        calls = []

        def always_fatal():
            calls.append(1)
            raise RuntimeError("CUBLAS failure 1: the library was not initialized")

        with patch.object(auto_tagger, "_ONNX_CUDA_DISABLED", False),                 patch.object(auto_tagger, "_ONNX_CPU_REBUILT", set()),                 patch.object(auto_tagger._cl_tagger, "unload", Mock(return_value=False)):
            for _ in range(3):
                result = auto_tagger._run_optional("cl", always_fatal)

        # Three images plus exactly one CPU rebuild, not one retry per image,
        # and a model that stays broken still reports the error.
        self.assertEqual(len(calls), 4)
        self.assertIsNotNone(result.error)


if __name__ == "__main__":
    unittest.main()
