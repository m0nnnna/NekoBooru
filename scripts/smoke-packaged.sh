#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${1:-}"
if [ -z "$PACKAGE" ]; then
  echo "Usage: scripts/smoke-packaged.sh path/to/nekobooru.deb" >&2
  exit 2
fi

echo "Smoke package: $PACKAGE"
echo "Install the package in a disposable VM/container, then verify:"
echo "  curl -fsS http://127.0.0.1:8772/api/health"
echo "  curl -fsS http://127.0.0.1:8772/api/runtime/status"
echo "  curl -fsS http://127.0.0.1:8772/api/settings"
