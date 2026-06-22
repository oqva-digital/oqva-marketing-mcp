#!/usr/bin/env bash
# Build the OQVA Marketing MCP release binaries — one self-contained file per platform.
# Maintainer-only; run from the repo root: ./build.sh
#
# Requires Bun (https://bun.sh):  curl -fsSL https://bun.sh/install | bash
# Output lands in dist/. Attach those files to a GitHub release; install.sh downloads them.
set -euo pipefail

command -v bun >/dev/null 2>&1 || {
  echo "Bun is required to build the binaries:  curl -fsSL https://bun.sh/install | bash"
  exit 1
}

OUT="dist"
ENTRY="src/index.ts"
mkdir -p "$OUT"

# <bun target>            <asset name = oqva-marketing-mcp-$(uname -s)-$(uname -m)>
build() {
  echo "→ building $2"
  bun build "$ENTRY" --compile --minify --target="$1" --outfile "$OUT/$2"
}

build bun-darwin-arm64 oqva-marketing-mcp-Darwin-arm64
build bun-darwin-x64   oqva-marketing-mcp-Darwin-x86_64
build bun-linux-x64    oqva-marketing-mcp-Linux-x86_64
build bun-linux-arm64  oqva-marketing-mcp-Linux-aarch64
build bun-windows-x64  oqva-marketing-mcp-Windows-x86_64.exe

echo
echo "Done. Binaries are in $OUT/ — create a GitHub release and upload all five."
echo "macOS binaries are unsigned; install.sh strips the download quarantine so they run."
