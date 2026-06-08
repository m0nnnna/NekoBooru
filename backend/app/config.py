import os
import sys
from pathlib import Path
from pydantic import model_validator
from pydantic_settings import BaseSettings
from .runtime_paths import runtime_paths
from .services.settings import SettingsManager


def get_base_dir() -> Path:
    """Get the base directory, handling both normal and PyInstaller frozen modes."""
    return runtime_paths.app_dir


def get_bundle_dir() -> Path:
    """Get the bundle directory where internal resources are stored."""
    return runtime_paths.bundle_dir


class Settings(BaseSettings):
    app_name: str = "NekoBooru"
    # Only toggles SQLAlchemy echo (logs every SQL statement). That's very
    # noisy and adds per-query overhead, so it's off by default. Set
    # NEKO_DEBUG=true to re-enable query logging while troubleshooting.
    debug: bool = False

    # Paths. In source mode these default to the checkout; in packaged mode
    # runtime_paths moves generated files into user-writable app data folders.
    base_dir: Path = get_base_dir()
    config_dir: Path | None = None
    config_file: Path | None = None
    logs_dir: Path = runtime_paths.logs_dir
    models_dir: Path = runtime_paths.models_dir
    runtimes_dir: Path = runtime_paths.runtimes_dir
    ai_venv_dir: Path = runtime_paths.ai_venv_dir

    # Thumbnail settings
    thumb_size: int = 300
    thumb_quality: int = 85

    # Upload settings
    max_upload_size: int = 100 * 1024 * 1024  # 100MB
    allowed_extensions: set = {".jpg", ".jpeg", ".png", ".gif", ".webm", ".webp", ".mp4"}

    # Optional auto-tagging. Disabled by default because the WD-Tagger stack is
    # large; set NEKO_AUTO_TAGGER_ENABLED=true after installing the optional
    # tagger requirements.
    auto_tagger_enabled: bool = False
    auto_tagger_model: str = "wd-eva02-large-tagger-v3"
    auto_tagger_general_threshold: float = 0.35
    auto_tagger_character_threshold: float = 0.45
    auto_tagger_max_tags: int = 40
    auto_tagger_apply_safety: bool = True

    # Server settings
    # Bind to loopback by default so the API is reachable only from this
    # machine. The app has no authentication, so exposing it on a network gives
    # anyone who can reach the port full read/write access. To intentionally
    # serve other devices on your LAN, set NEKO_HOST=0.0.0.0 (and ideally put it
    # behind a reverse proxy with auth).
    host: str = "127.0.0.1"
    port: int = 8772

    # Browser origins allowed to call the API (CORS). Local-only by default:
    # the web UI is served same-origin and the extension/Android app aren't
    # subject to CORS, so nothing here is needed for normal use. Restricting it
    # stops arbitrary websites you visit from scripting requests to your
    # instance. Override with NEKO_CORS_ORIGINS as a comma-separated list to
    # allow the web UI from another device's browser, e.g.
    # NEKO_CORS_ORIGINS="http://192.168.1.50:8772".
    cors_origins: str = (
        "http://localhost:8772,http://127.0.0.1:8772,"
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:3000,http://127.0.0.1:3000"
    )

    class Config:
        env_prefix = "NEKO_"

    @model_validator(mode="after")
    def set_derived_paths(self):
        if self.config_dir is None:
            self.config_dir = runtime_paths.config_dir
        if self.config_file is None:
            self.config_file = runtime_paths.config_file
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        """Parse ``cors_origins`` into a clean list of allowed origins."""
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]
    
    @property
    def data_dir(self) -> Path:
        """Get data directory from settings file or use default."""
        if os.environ.get("NEKO_DATA_DIR"):
            return runtime_paths.data_dir
        settings_manager = SettingsManager(self.config_file)
        configured_dir = settings_manager.get_data_dir()
        if configured_dir:
            return Path(configured_dir).resolve()
        return runtime_paths.data_dir
    
    @property
    def database_path(self) -> Path:
        """Get database path."""
        return self.data_dir / "nekobooru.db"
    
    @property
    def posts_dir(self) -> Path:
        """Get posts directory."""
        return self.data_dir / "posts"
    
    @property
    def thumbs_dir(self) -> Path:
        """Get thumbs directory."""
        return self.data_dir / "thumbs"
    
    @property
    def uploads_dir(self) -> Path:
        """Get uploads directory."""
        return self.data_dir / "uploads"

    @property
    def cache_dir(self) -> Path:
        """Get cache directory (e.g. on-demand video->gif conversions)."""
        if os.environ.get("NEKO_CACHE_DIR") or runtime_paths.packaged:
            return runtime_paths.cache_dir
        return self.data_dir / "cache"


settings = Settings()

# Ensure directories exist
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.posts_dir.mkdir(parents=True, exist_ok=True)
settings.thumbs_dir.mkdir(parents=True, exist_ok=True)
settings.uploads_dir.mkdir(parents=True, exist_ok=True)
settings.cache_dir.mkdir(parents=True, exist_ok=True)
settings.config_dir.mkdir(parents=True, exist_ok=True)
settings.logs_dir.mkdir(parents=True, exist_ok=True)
settings.models_dir.mkdir(parents=True, exist_ok=True)
settings.runtimes_dir.mkdir(parents=True, exist_ok=True)

# Keep downloaded model weights under NekoBooru's runtime model directory unless
# the user explicitly configured Hugging Face caches themselves.
os.environ.setdefault("HF_HOME", str(settings.models_dir / "huggingface"))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(settings.models_dir / "huggingface" / "hub"))
