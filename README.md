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

### AI Auto-Tagging (optional)
- Local image/video tagging (WD/Camie taggers, plus optional OCR/Whisper/Qwen)
- Disabled by default and **not bundled** with the app — install the AI stack only where you want it
- Offload inference to a **remote GPU worker** on your LAN so the main server stays light
- See [AI Auto-Tagging](#ai-auto-tagging-optional-1) below

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
- Frontend: http://localhost:5173 (dev) or http://localhost:8772 (prod)
- API Docs: http://localhost:8772/docs

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
NEKO_PORT=8772      # Backend port
NEKO_HOST=0.0.0.0   # Backend host
NEKO_DEBUG=True     # Debug mode
```

### Settings
The data directory can be configured in the Settings page or by editing `config/settings.json`.

## AI Auto-Tagging (optional)

AI tagging is **off by default and not part of the base install or the shipped binary** — the model
stack (torch/CUDA, onnxruntime, transformers) is large, so you install it only where you want it.

### Install the AI runtime
The easiest way is the installer script, which creates/uses the project venv,
installs everything, and verifies torch/onnxruntime:
```bash
# Windows (auto-detects the GPU and installs the matching stack):
.\install-ai.ps1            # auto: standard / legacy / CPU based on the GPU
.\install-ai.ps1 -CPU       # force CPU only
.\install-ai.ps1 -Legacy    # force older Pascal GPU (GTX 10-series, CUDA 12.6)
.\install-ai.ps1 -GPU       # force standard CUDA 12.8
# Linux / macOS:
./install-ai.sh             # auto-detect
./install-ai.sh --cpu / --legacy / --gpu
```
The installer is idempotent and self-healing: it detects the GPU's compute
capability via `nvidia-smi` (7.0+ → CUDA 12.8, 6.x Pascal → CUDA 12.6, else CPU),
skips work if the right build is already present, and if an installed build can't
launch a kernel on your GPU it uninstalls it and installs the correct one (auto
falling back standard → legacy → CPU).
Or install manually into the Python environment running NekoBooru:
```bash
# NVIDIA GPU (CUDA 12.8):
pip install -r backend/requirements-tagger.txt
# Older Pascal GPU — GTX 10-series / sm_61 (CUDA 12.6):
pip install -r backend/requirements-tagger-legacy.txt
# CPU only (slower; large models may be impractical):
pip install -r backend/requirements-tagger-cpu.txt
```
Then open **Settings → Auto Tagging**, toggle **Enable AI features**, and download the models you want.
The web UI also shows these commands and a CPU/GPU picker when the runtime isn't installed yet.

### Benchmark tagging speed
To see how fast tagging runs on your hardware (and the GPU vs CPU speedup), run
the benchmark with the venv that has the AI stack:
```bash
# Windows
venv\Scripts\python.exe benchmark-tagger.py
# Linux / macOS
venv/bin/python benchmark-tagger.py
```
It times the default WD tagger (preprocess + inference) on CPU and GPU and prints
per-image latency, throughput, and projected times for bulk runs. Use
`--images <folder>` to benchmark your own files, or `--device cpu|gpu|both`.

> **Older NVIDIA GPUs:** PyTorch's default CUDA 12.8 builds dropped Maxwell/Pascal/Volta
> support, so on a GTX 10-series card (e.g. 1060, `sm_61`) the standard GPU install fails
> with *"no kernel image is available for execution on the device"*. Use the **Legacy**
> option above (CUDA 12.6 wheels, which still include `sm_61`). Maxwell cards (GTX 9-series,
> `sm_50/52`) aren't in CUDA 12.6 either — use the CPU stack there.

> **Note:** the AI stack only works from a source checkout. The shipped Windows
> `nekobooru.exe` excludes torch/onnxruntime/transformers and cannot load them,
> so run the app from source (`start.bat`) on any machine that does tagging —
> including a [remote GPU worker](#remote-gpu-worker-run-inference-on-another-machine)
> (`start-worker.bat`).

### Remote GPU worker (run inference on another machine)
If your GPU is on a different LAN machine, keep the main server light and offload tagging to a **worker**:

1. **On the GPU machine**, run a normal NekoBooru instance with the AI stack installed
   (`pip install -r backend/requirements-tagger.txt`), reachable on the LAN
   (`NEKO_HOST=0.0.0.0`), and set a shared secret:
   ```bash
   NEKO_TAGGER_WORKER_TOKEN=<your-secret>
   ```
   Download/load the models there via its own **Settings → Auto Tagging**.
2. **On the main server**, go to **Settings → Auto Tagging → Compute location**, enable
   **Run AI on a remote GPU worker**, enter the worker URL (e.g. `http://192.168.1.50:8772`) and the
   same token, then click **Test connection**.

All tagging (uploads, per-post, and bulk backfill jobs) is then forwarded to the worker's
`/api/auto-tags/infer` endpoint. If the worker is offline, uploads are still saved — just untagged —
and you'll see a warning. Setting `NEKO_TAGGER_WORKER_TOKEN` is recommended since the worker has no
authentication otherwise.

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
