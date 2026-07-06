#!/usr/bin/env bash
# Fetch the prebuilt mcp-v8 (run_js) server binary from the mcp-js GitHub
# release, instead of building it from source. Writes bin/mcp-v8.
#
#   ./fetch-mcp-v8.sh            # latest pinned version, this OS/arch
#   MCP_V8_VERSION=v0.18.1 ./fetch-mcp-v8.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${MCP_V8_VERSION:-v0.18.1}"
REPO="r33drichards/mcp-js"

os="$(uname -s)"; arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)        asset="mcp-v8-macos-arm64" ;;
  Linux/x86_64)        asset="mcp-v8-linux" ;;
  Linux/aarch64|Linux/arm64) asset="mcp-v8-linux-arm64" ;;
  *) echo "no prebuilt mcp-v8 for $os/$arch — set MCP_V8_BIN or build from source (nix build .#mcp-v8)" >&2; exit 1 ;;
esac

mkdir -p "$HERE/bin"
out="$HERE/bin/mcp-v8"
url="https://github.com/$REPO/releases/download/$VERSION/${asset}.gz"
echo "==> fetching $asset ($VERSION)" >&2
curl -fsSL -o "$out.gz" "$url"
gunzip -f "$out.gz"
chmod +x "$out"
"$out" --version >&2
echo "==> wrote $out" >&2
