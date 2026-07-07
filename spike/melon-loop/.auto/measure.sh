#!/usr/bin/env bash
# pi-autoresearch measure step.
#
# Metric = number of sim postconditions PASSED (direction: MAXIMIZE; target = 5).
# It runs the current prog.lua through the sandboxed mcp-v8 languages server via
# run_js — the same "pi tool" path the restricted sub-agent uses — and prints the
# bare metric integer on stdout. Diagnostics (failing assertions) go to stderr.
set -euo pipefail
cd "$(dirname "$0")/.."
# run_sim prints diagnostics to stderr and the bare metric integer as its last
# stdout line; emit only that integer so pi-autoresearch reads a clean number.
uv run bin/run_sim.py --port "${SPIKE_PORT:-8791}" --spec spec.yaml | tail -n1
