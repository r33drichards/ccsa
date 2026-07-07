#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
echo "[start] craftos sim server on :8790"
MCP_V8_PORT=8790 MCP_V8_SESSION_DB_PATH=/tmp/mcp-v8-sess ./run-languages-mcp.sh > /tmp/sim.log 2>&1 &
sleep 8
echo "[start] temporal worker (temporal=$TEMPORAL_ADDRESS)"
( cd pi-turtle/flow && npx tsx worker.ts > /tmp/worker.log 2>&1 & )
sleep 2
echo "[start] MCP HTTP server on :${PORT:-8080}/mcp"
cd "$ROOT/pi-turtle/flow"
exec env MCP_HTTP_PORT="${PORT:-8080}" npx tsx server.ts
