#!/usr/bin/env bash
# OQVA Marketing MCP — one-command installer.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/oqva-digital/oqva-marketing-mcp/main/install.sh)"
#
# Downloads the binary for your computer, then runs the setup wizard that connects your
# Google and Meta accounts and registers the tool with Claude.
set -euo pipefail

REPO="oqva-digital/oqva-marketing-mcp"

BIN_NAME="oqva-marketing-mcp"
INSTALL_DIR="${OQVA_INSTALL_DIR:-$HOME/.local/bin}"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin|Linux) ;;
  *)
    echo "This installer covers macOS and Linux."
    echo "On Windows: download ${BIN_NAME}-Windows-x86_64.exe from"
    echo "  https://github.com/${REPO}/releases/latest"
    echo "then run:  ${BIN_NAME}-Windows-x86_64.exe setup"
    exit 1
    ;;
esac

ASSET="${BIN_NAME}-${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
TARGET="$INSTALL_DIR/$BIN_NAME"

echo "Downloading ${ASSET}…"
mkdir -p "$INSTALL_DIR"
if ! curl -fSL --progress-bar "$URL" -o "$TARGET"; then
  echo
  echo "Couldn't download $URL"
  echo "Open the Releases page and grab the file for your system manually:"
  echo "  https://github.com/${REPO}/releases/latest"
  exit 1
fi
chmod +x "$TARGET"

# macOS tags downloads with a quarantine flag that triggers a Gatekeeper block on unsigned
# apps; clear it so the freshly-downloaded binary runs without a scary prompt.
[ "$OS" = "Darwin" ] && xattr -d com.apple.quarantine "$TARGET" 2>/dev/null || true

echo "Installed to $TARGET"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Tip: add $INSTALL_DIR to your PATH to run '$BIN_NAME' from anywhere." ;;
esac

echo
exec "$TARGET" setup
