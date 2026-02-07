# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec file for NekoBooru."""

import os

block_cipher = None
base_dir = os.path.abspath('.')

a = Analysis(
    [os.path.join('backend', 'nekobooru.py')],
    pathex=[os.path.join(base_dir, 'backend')],
    binaries=[],
    datas=[
        # Bundle the frontend dist into the executable
        (os.path.join('frontend', 'dist'), 'frontend'),
    ],
    hiddenimports=[
        # Uvicorn internals
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.wsproto_impl',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        # FastAPI / Starlette
        'fastapi',
        'starlette',
        'starlette.responses',
        'starlette.routing',
        'starlette.middleware',
        'starlette.middleware.cors',
        'starlette.staticfiles',
        # SQLAlchemy + async
        'sqlalchemy',
        'sqlalchemy.ext.asyncio',
        'sqlalchemy.dialects.sqlite',
        'aiosqlite',
        # Pydantic
        'pydantic',
        'pydantic_settings',
        'pydantic.deprecated.decorator',
        # HTTP / multipart
        'httpx',
        'multipart',
        'python_multipart',
        # Async file I/O
        'aiofiles',
        'aiofiles.os',
        'aiofiles.ospath',
        # Image processing
        'PIL',
        'PIL.Image',
        'PIL.ImageOps',
        # Other
        'h11',
        'anyio',
        'anyio._backends',
        'anyio._backends._asyncio',
        'sniffio',
        'idna',
        'certifi',
        'httpcore',
        'email.mime.multipart',
        'email.mime.text',
        # App modules
        'app',
        'app.main',
        'app.config',
        'app.database',
        'app.models',
        'app.models.post',
        'app.models.tag',
        'app.models.pool',
        'app.models.comment',
        'app.models.note',
        'app.models.favorite',
        'app.routers',
        'app.routers.uploads',
        'app.routers.posts',
        'app.routers.tags',
        'app.routers.pools',
        'app.routers.notes',
        'app.routers.comments',
        'app.routers.settings',
        'app.services',
        'app.services.media',
        'app.services.search',
        'app.services.settings',
        'app.utils',
        'app.utils.hashing',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'numpy',
        'scipy',
        'pandas',
        'test',
        'unittest',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name='nekobooru',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    console=True,
    icon=os.path.join('frontend', 'public', 'favicon.ico')
    if os.path.exists(os.path.join('frontend', 'public', 'favicon.ico'))
    else None,
)
