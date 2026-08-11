import asyncio
import sys
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import PropertyMock, patch

from PIL import Image


class PixivUgoiraTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def test_url_validation_only_accepts_pixiv_cdn_zip(self):
        from app.services.pixiv_ugoira import validate_pixiv_ugoira_url

        valid = "https://i.pximg.net/img-zip-ugoira/img/2021/09/01/00/00/00/92781927_ugoira1920x1080.zip"
        self.assertEqual(validate_pixiv_ugoira_url(valid), valid)
        with self.assertRaises(ValueError):
            validate_pixiv_ugoira_url("https://example.com/animation.zip")
        with self.assertRaises(ValueError):
            validate_pixiv_ugoira_url("https://i.pximg.net/preview.jpg")

    def test_conversion_uses_every_frame_and_delay(self):
        from app.services import pixiv_ugoira

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            archive = root / "animation.zip"
            destination = root / "animation.mp4"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("000000.jpg", b"first")
                output.writestr("000001.jpg", b"second")

            captured = {}

            def fake_run(command, **options):
                captured["command"] = command
                captured["concat"] = (Path(options["cwd"]) / "frames.ffconcat").read_text(encoding="utf-8")
                destination.write_bytes(b"mp4")

                class Result:
                    returncode = 0
                    stderr = b""

                return Result()

            with patch.object(pixiv_ugoira.subprocess, "run", side_effect=fake_run):
                pixiv_ugoira.convert_ugoira_zip_to_mp4(
                    archive,
                    [{"file": "000000.jpg", "delay": 60}, {"file": "000001.jpg", "delay": 120}],
                    destination,
                )

            self.assertIn("duration 0.060000", captured["concat"])
            self.assertIn("duration 0.120000", captured["concat"])
            self.assertEqual(captured["concat"].count("file '000001.jpg'"), 2)
            self.assertIn("libx264", captured["command"])
            self.assertTrue(destination.exists())

    def test_conversion_rejects_unsafe_or_missing_frames(self):
        from app.services.pixiv_ugoira import convert_ugoira_zip_to_mp4, normalize_frames

        with self.assertRaises(ValueError):
            normalize_frames([{"file": "../escape.jpg", "delay": 60}])

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            archive = root / "animation.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("000000.jpg", b"first")
            with self.assertRaisesRegex(ValueError, "missing"):
                convert_ugoira_zip_to_mp4(
                    archive,
                    [{"file": "000001.jpg", "delay": 60}],
                    root / "animation.mp4",
                )

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is not installed")
    def test_real_conversion_produces_playable_mp4(self):
        from app.services.pixiv_ugoira import convert_ugoira_zip_to_mp4

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            frame_paths = []
            for index, color in enumerate(((255, 0, 0), (0, 0, 255))):
                frame_path = root / f"{index:06d}.jpg"
                Image.new("RGB", (64, 48), color).save(frame_path, "JPEG")
                frame_paths.append(frame_path)
            archive = root / "animation.zip"
            with zipfile.ZipFile(archive, "w") as output:
                for frame_path in frame_paths:
                    output.write(frame_path, frame_path.name)
            destination = root / "animation.mp4"
            convert_ugoira_zip_to_mp4(
                archive,
                [{"file": "000000.jpg", "delay": 80}, {"file": "000001.jpg", "delay": 120}],
                destination,
            )
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", str(destination)],
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            )
            self.assertEqual(probe.stdout.strip(), "h264,64,48")

    def test_upload_endpoint_registers_converted_mp4(self):
        from app.routers import uploads

        class FakeResponse:
            headers = {"content-length": "7"}
            url = "https://i.pximg.net/img-zip-ugoira/original.zip"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            def raise_for_status(self):
                return None

            async def aiter_bytes(self, _size):
                yield b"zipdata"

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            def stream(self, *_args, **_kwargs):
                return FakeResponse()

        with tempfile.TemporaryDirectory() as raw:
            upload_dir = Path(raw)

            def fake_convert(_archive, _frames, destination):
                destination.write_bytes(b"mp4")

            request = uploads.PixivUgoiraRequest(
                url="https://i.pximg.net/img-zip-ugoira/original.zip",
                frames=[{"file": "000000.jpg", "delay": 60}],
            )
            with patch.object(type(uploads.settings), "uploads_dir", new_callable=PropertyMock, return_value=upload_dir), \
                    patch.object(uploads, "check_ffmpeg_available", return_value=True), \
                    patch.object(uploads, "convert_ugoira_zip_to_mp4", side_effect=fake_convert), \
                    patch.object(uploads.httpx, "AsyncClient", return_value=FakeClient()):
                result = asyncio.run(uploads.upload_from_pixiv_ugoira(request))

            token = result["token"]
            self.assertEqual(result["frameCount"], 1)
            self.assertEqual(uploads.upload_tokens[token], upload_dir / f"{token}.mp4")
            self.assertFalse((upload_dir / f"{token}.ugoira.zip").exists())
            uploads.remove_upload_token(token)


if __name__ == "__main__":
    unittest.main()
