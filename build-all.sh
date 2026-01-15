#!/bin/bash
# Build script for all platforms

set -e

VERSION="${1:-1.0.0}"

echo "========================================"
echo "  NekoBooru Build All Platforms"
echo "========================================"
echo "Version: $VERSION"
echo

# Build Ubuntu/Linux
echo "Building Ubuntu/Linux package..."
bash build-ubuntu.sh "$VERSION"

# Build .deb package if on Linux
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v dpkg-deb &> /dev/null; then
        echo
        echo "Building .deb package..."
        bash build-deb.sh "$VERSION"
    else
        echo "dpkg-deb not found, skipping .deb package"
    fi
fi

echo
echo "========================================"
echo "  All Builds Complete!"
echo "========================================"
echo
echo "Distribution packages:"
echo "  - Ubuntu: dist/nekobooru-ubuntu/"
if [[ "$OSTYPE" == "linux-gnu"* ]] && command -v dpkg-deb &> /dev/null; then
    echo "  - Debian: dist/nekobooru_${VERSION}_all.deb"
fi
echo
