#!/usr/bin/env bash
# Run a CC turtle program against a fake world under CraftOS-PC.
#
#   ./sim/turtle-test.sh <world.lua> <program.lua>
#
# Exit code 0 = PASS, 1 = FAIL (CI-friendly). Set SIM_VERBOSE=1 to also dump
# the raw emulator output, SIM_TIMEOUT to change the watchdog (default 30s).
set -euo pipefail

SIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SIM_DIR/.." && pwd)"
ROM="${CRAFTOS_ROM:-$REPO/../craftos2-rom}"
CRAFTOS="$REPO/craftos"
TIMEOUT="${SIM_TIMEOUT:-30}"

if [ $# -lt 2 ]; then
  echo "usage: $0 <world.lua> <program.lua>" >&2
  exit 2
fi
[ -x "$CRAFTOS" ] || { echo "craftos binary not found/built at $CRAFTOS" >&2; exit 2; }
[ -d "$ROM" ] || { echo "ROM not found at $ROM (set CRAFTOS_ROM)" >&2; exit 2; }

world_abs="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
prog_abs="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
[ -f "$world_abs" ] || { echo "world not found: $1" >&2; exit 2; }
[ -f "$prog_abs" ]  || { echo "program not found: $2" >&2; exit 2; }

world_dir="$(dirname "$world_abs")"; world_base="$(basename "$world_abs")"
prog_dir="$(dirname "$prog_abs")";   prog_base="$(basename "$prog_abs")"

OUT_DIR="$(mktemp -d)"
DATA_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR" "$DATA_DIR"' EXIT

# Run headless with a watchdog (macOS has no `timeout`).
set +e
"$CRAFTOS" --rom "$ROM" -d "$DATA_DIR" --headless \
  --mount-ro "/sim=$SIM_DIR" \
  --mount-rw "/out=$OUT_DIR" \
  --mount-ro "/w=$world_dir" \
  --mount-ro "/p=$prog_dir" \
  --script "$SIM_DIR/harness.lua" \
  --args "/w/$world_base /p/$prog_base" \
  >"$OUT_DIR/emu.log" 2>&1 &
pid=$!
waited=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 1; waited=$((waited+1))
  if [ "$waited" -ge "$TIMEOUT" ]; then kill "$pid" 2>/dev/null; break; fi
done
wait "$pid" 2>/dev/null
set -e

if [ "${SIM_VERBOSE:-0}" = "1" ]; then
  echo "--- raw emulator output ---"; cat "$OUT_DIR/emu.log"; echo "---------------------------"
fi

result="$OUT_DIR/result.txt"
if [ ! -f "$result" ]; then
  echo "FAIL: harness produced no result (timed out after ${TIMEOUT}s or crashed)." >&2
  echo "      re-run with SIM_VERBOSE=1 to see emulator output." >&2
  exit 1
fi

cat "$result"
grep -q '^SIM_RESULT: PASS$' "$result" && exit 0 || exit 1
