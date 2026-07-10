#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CRAFTOS_ROM="${CRAFTOS_ROM:-/usr/local/share/craftos}"
export DYLD_LIBRARY_PATH="${DYLD_LIBRARY_PATH:-$ROOT/craftos2-lua/src}"
./sim/turtle-test.sh sim/worlds/farming.lua sim/examples/farming.lua
