#!/usr/bin/env bash
# Convenience launcher for the locally-built CraftOS-PC.
# Points the binary at the cloned ROM and a local data dir so no sudo/install is needed.
#
# Usage examples:
#   ./run.sh                                  # interactive GUI terminal (SDL window)
#   ./run.sh --cli                            # interactive ncurses terminal in this shell
#   ./run.sh --headless --exec 'print(2+2) os.shutdown()'   # run Lua, dump to stdout
#   ./run.sh --headless --script myprog.lua   # run a Lua file then drop to shell
#
# Any extra args are passed straight through to the craftos binary (see ./craftos --help).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROM="${CRAFTOS_ROM:-$HERE/../craftos2-rom}"
DATA="${CRAFTOS_DATA:-$HERE/.craftos-data}"
exec "$HERE/craftos" --rom "$ROM" -d "$DATA" "$@"
