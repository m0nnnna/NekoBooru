# NekoBooru Build Guide

This guide explains how to build distribution packages for Windows and Ubuntu/Linux.

## Prerequisites

### Windows
- Python 3.8+
- Node.js and npm
- PowerShell (for creating ZIP archives)

### Ubuntu/Linux
- Python 3.8+
- Node.js and npm
- dpkg-deb (for .deb packages, optional)

## Building

### Windows

Build a Windows distribution package:

```batch
build-windows.bat
```

This creates:
- `dist/nekobooru-windows/` - Complete distribution package
- Includes frontend build, backend code, and startup scripts
- Run `install.bat` to set up, then `start.bat` to run

Create a ZIP archive:
```powershell
powershell Compress-Archive -Path "dist\nekobooru-windows" -DestinationPath "dist\nekobooru-windows-1.0.0.zip" -Force
```

### Ubuntu/Linux

Build a Linux distribution package:

```bash
chmod +x build-ubuntu.sh
./build-ubuntu.sh [version]
```

This creates:
- `dist/nekobooru-ubuntu/` - Complete distribution package
- Includes frontend build, backend code, and startup scripts
- Run `./install.sh` to set up, then `./start.sh` to run

Create a tarball:
```bash
cd dist && tar -czf nekobooru-ubuntu-1.0.0.tar.gz nekobooru-ubuntu
```

### Debian Package (.deb)

Build a .deb package for easy installation:

```bash
chmod +x build-deb.sh
./build-deb.sh [version]
```

This creates:
- `dist/nekobooru_1.0.0_all.deb` - Debian package

Install:
```bash
sudo dpkg -i dist/nekobooru_1.0.0_all.deb
sudo apt-get install -f  # Fix dependencies if needed
```

### Build All

**Windows:**
```batch
build-all.bat [version]
```

**Linux:**
```bash
chmod +x build-all.sh
./build-all.sh [version]
```

## Distribution Package Contents

### Windows Package
```
nekobooru-windows/
├── frontend/          # Built frontend (static files)
├── backend/           # Backend application
│   ├── app/          # Application code
│   ├── run.py        # Development server
│   ├── run_prod.py   # Production server
│   └── requirements.txt
├── install.bat       # Installation script
├── start.bat         # Production startup
├── start-dev.bat     # Development startup
└── README.txt        # Instructions
```

### Ubuntu Package
```
nekobooru-ubuntu/
├── frontend/          # Built frontend (static files)
├── backend/           # Backend application
│   ├── app/          # Application code
│   ├── run.py        # Development server
│   ├── run_prod.py   # Production server
│   └── requirements.txt
├── install.sh        # Installation script
├── start.sh          # Production startup
├── start-dev.sh      # Development startup
├── nekobooru.service # Systemd service file
├── install-service.sh # Service installation
└── README.md         # Instructions
```

## Production Deployment

### Windows

1. Extract the distribution package
2. Run `install.bat` to create virtual environment and install dependencies
3. Run `start.bat` to start the production server
4. Access at http://localhost:8000

### Ubuntu/Linux

**Option 1: Manual**
1. Extract the distribution package
2. Run `./install.sh` to set up
3. Run `./start.sh` to start

**Option 2: System Service**
1. Extract the distribution package
2. Run `sudo bash install-service.sh [username]`
3. Start with `sudo systemctl start nekobooru`
4. Enable on boot: `sudo systemctl enable nekobooru`

## Production Server

The production server (`run_prod.py`):
- Serves the built frontend from the backend
- No hot-reload (faster, more stable)
- Single process (use a process manager for production)
- Accessible at http://localhost:8000

## Development vs Production

- **Development**: Uses `run.py` with hot-reload, separate frontend dev server
- **Production**: Uses `run_prod.py`, serves frontend from backend, no reload

## Notes

- The frontend is built and served as static files by the backend in production
- All API routes are prefixed with `/api`
- Media files are served from `/media/posts/` and `/media/thumbs/`
- The frontend router handles client-side routing
- Settings are stored in `config/settings.json`
