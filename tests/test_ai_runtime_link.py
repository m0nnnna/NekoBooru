import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"


class AiRuntimeLinkTests(unittest.TestCase):
    """The managed AI venv must be importable whichever launcher started the app."""

    def test_importing_the_app_links_the_managed_ai_venv(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            venv = root / "runtimes" / "python-ai"
            if os.name == "nt":
                site_packages = venv / "Lib" / "site-packages"
            else:
                site_packages = venv / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
            (site_packages / "neko_ai_probe").mkdir(parents=True)
            (site_packages / "neko_ai_probe" / "__init__.py").write_text("", encoding="utf-8")

            env = {**os.environ}
            for key, sub in {
                "NEKO_CONFIG_DIR": "config",
                "NEKO_DATA_DIR": "data",
                "NEKO_LOGS_DIR": "logs",
                "NEKO_MODELS_DIR": "models",
                "NEKO_RUNTIMES_DIR": "runtimes",
                "NEKO_CACHE_DIR": "cache",
            }.items():
                env[key] = str(root / sub)
            env["NEKO_CONFIG_FILE"] = str(root / "config" / "settings.json")
            env.pop("NEKO_AI_VENV", None)

            # A fresh process, as run.py's reload worker or a bare uvicorn is:
            # the link is process-wide, so it cannot be checked in this one.
            probe = (
                "from importlib.util import find_spec\n"
                "assert find_spec('neko_ai_probe') is None\n"
                "import app.main\n"
                "print(find_spec('neko_ai_probe') is not None)\n"
            )
            result = subprocess.run(
                [sys.executable, "-c", probe], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines()[-1], "True")


if __name__ == "__main__":
    unittest.main()
