# NekoBooru Development Guide

## Quick Start

### Option 1: Start Both Servers Together (Recommended)

**Windows:**
```batch
start-dev.bat
```

**Linux/Mac:**
```bash
chmod +x start-dev.sh
./start-dev.sh
```

This will start both the backend and frontend servers automatically.

### Option 2: Start Servers Separately

**Backend (Terminal 1):**
```batch
# Windows
start.bat

# Linux/Mac
./start.sh
```

**Frontend (Terminal 2):**
```batch
# Windows
start-frontend.bat

# Linux/Mac
cd frontend && npm run dev
```

## Development URLs

- **Backend API**: http://localhost:8000
- **Backend API Docs**: http://localhost:8000/docs
- **Frontend**: http://localhost:3000

## Troubleshooting

### "Backend server is not running" Error

If you see this error in the frontend, it means the backend server isn't running on port 8000.

**Solution:**
1. Make sure you've started the backend server using `start.bat` (Windows) or `./start.sh` (Linux)
2. Check that the backend is running by visiting http://localhost:8000/docs
3. If the backend isn't starting, check the terminal for error messages

### "ECONNREFUSED" Proxy Error

This error means the Vite dev server can't connect to the backend.

**Common causes:**
- Backend server is not running
- Backend is running on a different port
- Firewall blocking the connection

**Solution:**
1. Ensure the backend is running on port 8000
2. Check `backend/app/config.py` for the port configuration
3. Verify no other application is using port 8000

### Port Already in Use

If you get a "port already in use" error:

**Backend (port 8000):**
- Change the port in `backend/app/config.py` or set `NEKO_PORT` environment variable
- Or stop the conflicting service

**Frontend (port 3000):**
- Change the port in `frontend/vite.config.js`
- Or stop the conflicting service

## Project Structure

```
nekobooru/
├── backend/          # FastAPI backend
│   ├── app/
│   │   ├── routers/  # API endpoints
│   │   ├── models/   # Database models
│   │   └── services/ # Business logic
│   └── run.py        # Development server
├── frontend/         # Vue.js frontend
│   ├── src/
│   │   ├── api/      # API client
│   │   ├── views/    # Page components
│   │   └── components/ # Reusable components
│   └── vite.config.js
├── data/             # Application data
│   ├── posts/        # Uploaded media files
│   └── thumbs/       # Thumbnail images
├── start.bat         # Backend launcher (Windows)
├── start.sh          # Backend launcher (Linux)
├── start-frontend.bat # Frontend launcher (Windows)
├── start-dev.bat     # Both servers (Windows)
└── start-dev.sh      # Both servers (Linux)
```

## API Development

The backend uses FastAPI with automatic API documentation:

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

## Frontend Development

The frontend uses Vite for fast development:

- Hot Module Replacement (HMR) is enabled
- API requests are proxied from `/api` to `http://localhost:8000/api`
- Changes to Vue components are reflected immediately

## Environment Variables

Backend configuration can be set via environment variables with the `NEKO_` prefix:

- `NEKO_PORT` - Backend port (default: 8000)
- `NEKO_HOST` - Backend host (default: 0.0.0.0)
- `NEKO_DEBUG` - Debug mode (default: True)

Example:
```bash
export NEKO_PORT=8080
```
