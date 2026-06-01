# NekoBooru

A lightweight, self-hosted booru-style image and video gallery application.  
Organize your personal media collection with tags, pools, favorites, and more.

## Features

### Media Management
- Upload images (JPG, PNG, GIF, WebP) and videos (WebM, MP4)
- Drag-and-drop and copy-paste uploading
- Upload from URL
- **Browser extension**: right-click any image/video on the web and "Download to NekoBooru" (see [`browser-extension/`](browser-extension/README.md))
- Automatic thumbnail generation
- Duplicate detection via SHA256 hashing
- File size limit: 100MB

### Tagging System
- Multi-category tags (General, Artist, Character, Copyright, Meta)
- Color-coded tag categories
- Tag implications (automatic tag application)
- Tag aliases (alternate names)
- Autocomplete search

### Organization
- **Pools**: Group posts into ordered collections
- **Favorites**: Mark posts as favorites
- **Notes**: Add annotations to images
- **Comments**: Comment on posts

### Search
- Tag-based queries: `cat dog`
- Negation: `-unwanted_tag`
- Sorting by date, ID, or file size
- Pagination

### Interface
- Grid-based gallery view
- Lightbox media viewer
- Dark/light theme toggle
- Responsive design

## Tech Stack

**Backend**: FastAPI, SQLAlchemy, SQLite, Pillow, FFmpeg (optional)

**Frontend**: Vue.js 3, Vite, Pinia, Vue Router

## Quick Start

### Prerequisites
- Python 3.8+
- Node.js and npm
- FFmpeg (optional, for video thumbnails)

### Development

**Windows:**
```batch
start-dev.bat
```

**Linux / macOS:**
```bash
chmod +x start-dev.sh
./start-dev.sh
```

### Production

**Windows:**
```batch
start.bat
```

**Linux / macOS:**
```bash
chmod +x start.sh
./start.sh
```

### Access
- Frontend: http://localhost:3000 (dev) or http://localhost:8000 (prod)
- API Docs: http://localhost:8000/docs

## Manual Setup

### Backend
```bash
# Create virtual environment
python -m venv venv

# Activate (Windows)
venv\Scripts\activate

# Activate (Linux/macOS)
source venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt

# Run server
cd backend
python run.py
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

## Project Structure

```
nekobooru/
├── backend/
│   ├── app/
│   │   ├── main.py        # FastAPI app
│   │   ├── config.py      # Configuration
│   │   ├── database.py    # Database setup
│   │   ├── routers/       # API endpoints
│   │   ├── models/        # SQLAlchemy models
│   │   └── services/      # Business logic
│   ├── run.py             # Dev server
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── views/         # Page components
│   │   ├── components/    # Reusable components
│   │   ├── stores/        # Pinia stores
│   │   ├── api/           # API client
│   │   └── router/        # Vue Router
│   └── package.json
├── data/                  # Media storage
│   ├── posts/             # Original files
│   ├── thumbs/            # Thumbnails
│   └── nekobooru.db       # Database
└── config/
    └── settings.json      # User settings
```

## API Endpoints

| Endpoint | Description |
|--------|-------------|
| GET /api/posts | List posts with search and pagination |
| POST /api/uploads | Upload a file |
| GET /api/tags | List tags |
| GET /api/pools | List pools |
| GET /api/settings/stats | Storage statistics |

Full API documentation is available at `/docs` when the server is running.

## Configuration

### Environment Variables
```bash
NEKO_PORT=8000      # Backend port
NEKO_HOST=0.0.0.0   # Backend host
NEKO_DEBUG=True     # Debug mode
```

### Settings
The data directory can be configured in the Settings page or by editing `config/settings.json`.

## Building for Distribution

**Windows:**
```batch
build-windows.bat
```

**Linux:**
```bash
./build-ubuntu.sh [version]
```

## Installing as a Service (Linux)
```bash
sudo bash install-service.sh [username]
sudo systemctl enable nekobooru
sudo systemctl start nekobooru
```

## License
