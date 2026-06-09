"""Settings management service."""
import json
import shutil
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class SettingsManager:
    """Manages application settings stored in a JSON file."""
    
    def __init__(self, config_file: Path):
        self.config_file = config_file
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
    
    def load_settings(self) -> dict:
        """Load settings from config file."""
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r', encoding='utf-8-sig') as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Failed to load settings: {e}")
                return {}
        return {}
    
    def save_settings(self, settings: dict) -> None:
        """Save settings to config file."""
        try:
            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(settings, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Failed to save settings: {e}")
            raise
    
    def get_data_dir(self) -> Optional[str]:
        """Get the configured data directory path."""
        settings = self.load_settings()
        return settings.get('data_dir')
    
    def set_data_dir(self, data_dir: str) -> None:
        """Set the data directory path."""
        settings = self.load_settings()
        settings['data_dir'] = data_dir
        self.save_settings(settings)

    def get_auto_tag_settings(self) -> dict:
        """Get persisted auto-tag settings."""
        settings = self.load_settings()
        return dict(settings.get("auto_tagging") or {})

    def set_auto_tag_settings(self, auto_tagging: dict) -> None:
        """Persist auto-tag settings without disturbing other settings."""
        settings = self.load_settings()
        settings["auto_tagging"] = auto_tagging
        self.save_settings(settings)

    def get_ytdlp_settings(self) -> dict:
        """Get persisted yt-dlp update settings."""
        settings = self.load_settings()
        return dict(settings.get("ytdlp") or {})

    def set_ytdlp_settings(self, ytdlp: dict) -> None:
        """Persist yt-dlp update settings without disturbing other settings."""
        settings = self.load_settings()
        settings["ytdlp"] = ytdlp
        self.save_settings(settings)

    def get_update_settings(self) -> dict:
        """Get persisted app update settings."""
        settings = self.load_settings()
        return dict(settings.get("updates") or {})

    def set_update_settings(self, updates: dict) -> None:
        """Persist app update settings without disturbing other settings."""
        settings = self.load_settings()
        settings["updates"] = updates
        self.save_settings(settings)

    def get_server_settings(self) -> dict:
        """Get persisted server bind/CORS settings."""
        settings = self.load_settings()
        return dict(settings.get("server") or {})

    def set_server_settings(self, server: dict) -> None:
        """Persist server bind/CORS settings without disturbing other settings."""
        settings = self.load_settings()
        settings["server"] = server
        self.save_settings(settings)

    def get_extension_settings(self) -> dict:
        """Get persisted browser-extension defaults."""
        settings = self.load_settings()
        return dict(settings.get("extension") or {})

    def set_extension_settings(self, extension: dict) -> None:
        """Persist browser-extension defaults without disturbing other settings."""
        settings = self.load_settings()
        settings["extension"] = extension
        self.save_settings(settings)

    def get_ai_model_defaults(self) -> dict:
        """Get persisted default model choices shared by app and extension AI previews."""
        settings = self.load_settings()
        return dict(settings.get("aiModelDefaults") or {})

    def set_ai_model_defaults(self, defaults: dict) -> None:
        """Persist shared default model choices without disturbing other settings."""
        settings = self.load_settings()
        settings["aiModelDefaults"] = defaults
        self.save_settings(settings)

    def get_huggingface_token(self) -> Optional[str]:
        """Get the locally stored Hugging Face token, if configured."""
        settings = self.load_settings()
        token = settings.get("huggingface_token")
        return str(token) if token else None

    def set_huggingface_token(self, token: str) -> None:
        """Persist a Hugging Face token locally."""
        settings = self.load_settings()
        settings["huggingface_token"] = token.strip()
        self.save_settings(settings)

    def delete_huggingface_token(self) -> None:
        """Remove the locally stored Hugging Face token."""
        settings = self.load_settings()
        settings.pop("huggingface_token", None)
        self.save_settings(settings)

    def get_tagger_worker_token(self) -> Optional[str]:
        """Get the shared token used to authenticate remote tagger-worker calls."""
        settings = self.load_settings()
        token = settings.get("tagger_worker_token")
        return str(token) if token else None

    def set_tagger_worker_token(self, token: str) -> None:
        """Persist the tagger-worker token locally."""
        settings = self.load_settings()
        settings["tagger_worker_token"] = token.strip()
        self.save_settings(settings)

    def delete_tagger_worker_token(self) -> None:
        """Remove the locally stored tagger-worker token."""
        settings = self.load_settings()
        settings.pop("tagger_worker_token", None)
        self.save_settings(settings)

    def normalize_path(self, path_str: str) -> str:
        """Normalize path for cross-platform compatibility."""
        # Convert to Path object to handle both Windows and Unix paths
        path = Path(path_str)
        # Return as string, using forward slashes for consistency
        # Path will handle the actual OS-specific separators
        return str(path.resolve())


def migrate_data_directory(old_dir: Path, new_dir: Path) -> dict:
    """
    Migrate data directory from old location to new location.
    Returns dict with migration results.
    """
    old_dir = Path(old_dir).resolve()
    new_dir = Path(new_dir).resolve()
    
    if old_dir == new_dir:
        return {
            "success": False,
            "message": "Source and destination directories are the same"
        }
    
    if not old_dir.exists():
        return {
            "success": False,
            "message": f"Source directory does not exist: {old_dir}"
        }
    
    if new_dir.exists() and any(new_dir.iterdir()):
        return {
            "success": False,
            "message": f"Destination directory is not empty: {new_dir}"
        }
    
    try:
        # Create destination directory structure
        new_dir.mkdir(parents=True, exist_ok=True)
        
        # Copy all contents
        copied_files = 0
        copied_dirs = 0
        
        for item in old_dir.iterdir():
            dest = new_dir / item.name
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
                copied_dirs += 1
            else:
                shutil.copy2(item, dest)
                copied_files += 1
        
        return {
            "success": True,
            "message": f"Successfully migrated data directory",
            "old_path": str(old_dir),
            "new_path": str(new_dir),
            "files_copied": copied_files,
            "directories_copied": copied_dirs
        }
    except Exception as e:
        logger.error(f"Migration failed: {e}")
        return {
            "success": False,
            "message": f"Migration failed: {str(e)}"
        }
