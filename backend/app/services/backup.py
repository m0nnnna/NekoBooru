from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

from sqlalchemy import text

from ..config import settings
from ..database import engine

logger = logging.getLogger(__name__)

# How many auto-tag backups to keep before pruning the oldest.
BACKUP_KEEP = 10


def backups_dir() -> Path:
    d = settings.data_dir / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


async def create_backup(label: str = "auto") -> Path:
    """Snapshot the SQLite database to ``data/backups`` and return the path.

    Uses ``VACUUM INTO``, which produces a single consistent, compacted copy of
    a live (WAL) database without the ``-wal``/``-shm`` sidecars and without
    holding a long write lock. Runs under AUTOCOMMIT because VACUUM cannot run
    inside an open transaction.
    """
    label = "".join(c if c.isalnum() or c in "-_" else "-" for c in (label or "auto")) or "auto"
    dest = backups_dir() / f"nekobooru-{label}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    safe = str(dest).replace("'", "''")
    async with engine.connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        await conn.execute(text(f"VACUUM INTO '{safe}'"))
    logger.info("Created database backup: %s", dest)
    _prune_old_backups()
    return dest


def _prune_old_backups(keep: int = BACKUP_KEEP) -> None:
    files = sorted(
        backups_dir().glob("nekobooru-*.db"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in files[keep:]:
        try:
            old.unlink()
        except OSError as exc:  # noqa: BLE001
            logger.warning("Could not prune old backup %s: %s", old, exc)
