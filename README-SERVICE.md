# NekoBooru Service Installation

This guide explains how to run NekoBooru as a system service on Ubuntu/Linux.

## Quick Start (Windows)

Simply run `start.bat` - it will:
- Check for Python and create a virtual environment if needed
- Check for ffmpeg and warn if missing
- Automatically regenerate thumbnails for videos missing them
- Start the backend server

## Linux Service Installation

### Prerequisites

1. **Python 3.8+** - Usually pre-installed on Ubuntu
2. **ffmpeg** (optional but recommended for video thumbnails):
   ```bash
   sudo apt-get update
   sudo apt-get install ffmpeg
   ```

### Installation Steps

1. **Clone or copy the NekoBooru directory** to `/opt/nekobooru` (or your preferred location)

2. **Run the installation script**:
   ```bash
   sudo bash install-service.sh [username]
   ```
   
   Replace `[username]` with the user you want the service to run as (defaults to current user if not specified).

3. **Start the service**:
   ```bash
   sudo systemctl start nekobooru
   ```

4. **Enable on boot** (optional):
   ```bash
   sudo systemctl enable nekobooru
   ```

### Service Management

**Start the service:**
```bash
sudo systemctl start nekobooru
```

**Stop the service:**
```bash
sudo systemctl stop nekobooru
```

**Restart the service:**
```bash
sudo systemctl restart nekobooru
```

**Check status:**
```bash
sudo systemctl status nekobooru
```

**View logs:**
```bash
# Follow logs in real-time
sudo journalctl -u nekobooru -f

# View recent logs
sudo journalctl -u nekobooru -n 50
```

**View all logs:**
```bash
sudo journalctl -u nekobooru
```

### Manual Start (Development)

For development or testing, you can also use the shell script:

```bash
chmod +x start.sh
./start.sh
```

This will:
- Check for Python and create a virtual environment if needed
- Check for ffmpeg and warn if missing
- Automatically regenerate thumbnails for videos missing them
- Start the backend server

### Troubleshooting

**Service won't start:**
- Check logs: `sudo journalctl -u nekobooru -n 50`
- Verify Python is installed: `python3 --version`
- Verify virtual environment exists: `ls -la /opt/nekobooru/venv`
- Check file permissions: `ls -la /opt/nekobooru`

**Video thumbnails not generating:**
- Verify ffmpeg is installed: `ffmpeg -version`
- Check service logs for ffmpeg errors
- Manually run: `python regenerate_video_thumbnails.py`

**Permission errors:**
- Ensure the service user owns the installation directory:
  ```bash
  sudo chown -R username:username /opt/nekobooru
  ```

**Port already in use:**
- Change the port in `backend/app/config.py` or set `NEKO_PORT` environment variable
- Or stop the conflicting service

### Configuration

The service will automatically:
- Check for ffmpeg on startup
- Regenerate thumbnails for videos missing them
- Restart automatically if it crashes
- Log all output to systemd journal

To modify settings, edit `/opt/nekobooru/backend/app/config.py` or use environment variables with the `NEKO_` prefix.
