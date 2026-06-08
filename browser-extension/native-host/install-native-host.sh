#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.nekobooru.launcher"
EXTENSION_ID="${1:-${NEKO_EXTENSION_ID:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/nekobooru_launcher_host.py"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/nekobooru/native-messaging-hosts"
WRAPPER="$CONFIG_ROOT/nekobooru_launcher_host"
CONFIG_FILE="$CONFIG_ROOT/launcher-config.json"

mkdir -p "$CONFIG_ROOT"

cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec /usr/bin/env python3 "$HOST_SCRIPT"
EOF
chmod +x "$WRAPPER"

python3 - "$CONFIG_FILE" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
data.setdefault("appPath", "/usr/bin/nekobooru")
data.setdefault("backendPort", 8773)
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

write_chromium_manifest() {
  local dir="$1"
  local id="$2"
  mkdir -p "$dir"
  if [ -n "$id" ]; then
    cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Starts the local NekoBooru app for the browser extension.",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$id/"
  ]
}
EOF
  else
    cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Starts the local NekoBooru app for the browser extension.",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": []
}
EOF
  fi
}

write_firefox_manifest() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Starts the local NekoBooru app for the browser extension.",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_extensions": [
    "nekobooru@local"
  ]
}
EOF
}

if [ -n "$EXTENSION_ID" ]; then
  write_chromium_manifest "${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome/NativeMessagingHosts" "$EXTENSION_ID"
  write_chromium_manifest "${XDG_CONFIG_HOME:-$HOME/.config}/chromium/NativeMessagingHosts" "$EXTENSION_ID"
  write_chromium_manifest "${XDG_CONFIG_HOME:-$HOME/.config}/BraveSoftware/Brave-Browser/NativeMessagingHosts" "$EXTENSION_ID"
  write_chromium_manifest "${XDG_CONFIG_HOME:-$HOME/.config}/microsoft-edge/NativeMessagingHosts" "$EXTENSION_ID"
fi
write_firefox_manifest "$HOME/.mozilla/native-messaging-hosts"

echo "Installed NekoBooru native launcher manifests for this user."
if [ -z "$EXTENSION_ID" ]; then
  echo "Chromium manifests were skipped because no extension id was provided."
  echo "Rerun with: install-native-host.sh YOUR_CHROMIUM_EXTENSION_ID"
fi
