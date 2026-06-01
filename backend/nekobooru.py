#!/usr/bin/env python
"""NekoBooru standalone entry point for PyInstaller builds."""

import sys
import uvicorn
from app.config import settings
from app.main import app


def main():
    print(f"\n{'='*50}")
    print(f"  {settings.app_name}")
    print(f"{'='*50}")
    print(f"  URL: http://localhost:{settings.port}")
    print(f"  API Docs: http://localhost:{settings.port}/docs")
    print(f"  Database: {settings.database_path}")
    print(f"  Data Dir: {settings.data_dir}")
    print(f"{'='*50}\n")

    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
