#!/usr/bin/env bash
set -euo pipefail

backend_port="${NEKO_BACKEND_PORT:-8773}"
frontend_port="${NEKO_FRONTEND_PORT:-5174}"
ai_profile="${NEKO_AI_PROFILE:-skip}"
update_owner="${NEKO_UPDATE_OWNER:-m0nnnna}"
update_repo="${NEKO_UPDATE_REPO:-NekoBooru}"
update_channel="${NEKO_UPDATE_CHANNEL:-stable}"
host="${NEKO_HOST:-127.0.0.1}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backend-port) backend_port="${2:?}"; shift 2 ;;
    --frontend-port) frontend_port="${2:?}"; shift 2 ;;
    --ai-profile) ai_profile="${2:?}"; shift 2 ;;
    --update-owner) update_owner="${2:?}"; shift 2 ;;
    --update-repo) update_repo="${2:?}"; shift 2 ;;
    --update-channel) update_channel="${2:?}"; shift 2 ;;
    --host) host="${2:?}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

config_root="${XDG_CONFIG_HOME:-$HOME/.config}/nekobooru"
config_file="$config_root/settings.json"
mkdir -p "$config_root"

python3 - "$config_file" "$host" "$backend_port" "$frontend_port" "$ai_profile" "$update_owner" "$update_repo" "$update_channel" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
host, backend_port, frontend_port, ai_profile, owner, repo, channel = sys.argv[2:]
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}

data.setdefault("server", {})
data["server"].update({
    "host": host,
    "port": int(backend_port),
    "frontendPort": int(frontend_port),
    "corsOrigins": ",".join([
        f"http://localhost:{backend_port}",
        f"http://127.0.0.1:{backend_port}",
        f"http://localhost:{frontend_port}",
        f"http://127.0.0.1:{frontend_port}",
    ]),
})

data.setdefault("installer", {})
data["installer"].update({
    "platform": "linux",
    "aiProfile": ai_profile,
})

data.setdefault("updates", {})
data["updates"].update({
    "owner": owner,
    "repo": repo,
    "channel": channel,
})

path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/nekobooru" \
         "${XDG_CACHE_HOME:-$HOME/.cache}/nekobooru" \
         "${XDG_STATE_HOME:-$HOME/.local/state}/nekobooru/logs"

echo "Wrote $config_file"
