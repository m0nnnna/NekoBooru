#!/usr/bin/env python
"""Production server launcher for NekoBooru."""

import uvicorn
from app.config import settings

if __name__ == "__main__":
    print(f"\n{'='*50}")
    print(f"  {settings.app_name} - Production Server")
    print(f"{'='*50}")
    print(f"  URL: http://{settings.host}:{settings.port}")
    print(f"  API Docs: http://{settings.host}:{settings.port}/docs")
    print(f"  Database: {settings.database_path}")
    print(f"{'='*50}\n")

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,  # No reload in production
        log_level="info",
    )
