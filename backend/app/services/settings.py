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
                with open(self.config_file, 'r', encoding='utf-8') as f:
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
