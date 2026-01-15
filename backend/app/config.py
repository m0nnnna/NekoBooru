from pathlib import Path
from pydantic_settings import BaseSettings
from .services.settings import SettingsManager


class Settings(BaseSettings):
    app_name: str = "NekoBooru"
    debug: bool = True

    # Paths
    base_dir: Path = Path(__file__).parent.parent.parent
    config_dir: Path = base_dir / "config"
    config_file: Path = config_dir / "settings.json"
    
    # Default data directory (can be overridden by settings file)
    _default_data_dir: Path = base_dir / "data"

    # Thumbnail settings
    thumb_size: int = 300
    thumb_quality: int = 85

    # Upload settings
    max_upload_size: int = 100 * 1024 * 1024  # 100MB
    allowed_extensions: set = {".jpg", ".jpeg", ".png", ".gif", ".webm", ".webp", ".mp4"}

    # Server settings
    host: str = "0.0.0.0"
    port: int = 8000

    class Config:
        env_prefix = "NEKO_"
    
    @property
    def data_dir(self) -> Path:
        """Get data directory from settings file or use default."""
        settings_manager = SettingsManager(self.config_file)
        configured_dir = settings_manager.get_data_dir()
        if configured_dir:
            return Path(configured_dir).resolve()
        return self._default_data_dir.resolve()
    
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


settings = Settings()

# Ensure directories exist
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.posts_dir.mkdir(parents=True, exist_ok=True)
settings.thumbs_dir.mkdir(parents=True, exist_ok=True)
settings.uploads_dir.mkdir(parents=True, exist_ok=True)
settings.config_dir.mkdir(parents=True, exist_ok=True)
