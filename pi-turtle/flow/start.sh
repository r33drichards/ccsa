#!/usr/bin/env bash
# One container runs three cooperating processes:
#   1. craftos sim server (:8790)  — the research activity runs turtle programs against it
#   2. temporal worker             — polls the "turtle" task queue, executes the research activity
#   3. MCP HTTP server (:PORT)     — the public tool surface
# ALL logs go to stdout (visible in Railway). If ANY of the three exits, we tear the
# whole container down with a nonzero code so Railway restarts it fresh — this is what
# prevents the old failure mode where a silently-dead worker left activities PENDING
# forever while the MCP server kept the container "healthy".
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

pids=()
term() { echo "[start] shutting down"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; }
trap term EXIT INT TERM

echo "[start] craftos sim server on :8790"
# Persist mcp-v8's /work state on the mounted volume (/data) so a container
# restart/redeploy does NOT wipe it. Two independent stores must BOTH be durable:
#   * the fs blob store        (--work -> $WORK/fs), the content-addressed bytes
#   * the session DB           (MCP_V8_SESSION_DB_PATH), which holds the session
#                              log AND the fs-label reflog that resolves each
#                              X-MCP-Session-Id -> its latest /work snapshot.
# If EITHER lives on ephemeral storage (/tmp, /app), a restart leaves every
# in-flight, durable Temporal workflow pointing at an empty /work (ENOENT) —
# the sandbox silently dies mid-run and the whole run burns its budget at 0/0.
MCP_V8_DATA="${MCP_V8_DATA_DIR:-/data}"
mkdir -p "$MCP_V8_DATA/mcp-work" "$MCP_V8_DATA/mcp-v8-sess"
MCP_V8_PORT=8790 MCP_V8_SESSION_DB_PATH="$MCP_V8_DATA/mcp-v8-sess" \
  ./run-languages-mcp.sh --work "$MCP_V8_DATA/mcp-work" 2>&1 | sed -u 's/^/[sim] /' &
pids+=($!)
sleep 8

echo "[start] temporal worker (temporal=${TEMPORAL_ADDRESS:-localhost:7233})"
( cd pi-turtle/flow && exec npx tsx worker.ts ) 2>&1 | sed -u 's/^/[worker] /' &
pids+=($!)
sleep 2

echo "[start] MCP HTTP server on :${PORT:-8080}/mcp"
( cd pi-turtle/flow && exec env MCP_HTTP_PORT="${PORT:-8080}" npx tsx server.ts ) 2>&1 | sed -u 's/^/[mcp] /' &
pids+=($!)

# Wait for the FIRST process to exit; whichever dies, bring the container down so
# Railway restarts everything together (worker + sim + MCP stay in lockstep).
wait -n
code=$?
echo "[start] a process exited (code $code) — exiting container so Railway restarts it"
exit "${code:-1}"
