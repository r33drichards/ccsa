#!/usr/bin/env bash
# Pilot the turtle-making tool: a PURPOSE-BUILT, isolated pi session.
#
#   ./pi-turtle/pilot.sh                 # full tools + turtle_sim
#   ./pi-turtle/pilot.sh --restricted    # sandbox: ONLY turtle_sim (no bash/edit/write)
#
# Isolation: PI_CODING_AGENT_DIR points at pi-turtle/agent, and --no-skills /
# --no-context-files suppress your GLOBAL skills (cloudscape, electron, …) and
# ~/AGENTS.md. The only skills loaded are this repo's languages/skills/* (the
# CC:Tweaked API reference, craftos-sim, the turtle skills, picat) — the domain
# knowledge that helps the agent write correct turtle programs. Prereq: the
# languages server on :8790 —
#   MCP_V8_PORT=8790 MCP_V8_SESSION_DB_PATH=/tmp/mcp-v8-pi ./run-languages-mcp.sh &
set -euo pipefail
cd "$(dirname "$0")/.."                            # repo root

set -a; . ./.env; set +a                          # OLLAMA_API_KEY
export PI_CODING_AGENT_DIR="$PWD/pi-turtle/agent" # isolated config (no global pollution)

ARGS=(--provider ollama --model glm-5.2 -a
      -e pi-turtle/index.ts
      --append-system-prompt "$(cat pi-turtle/system.md)"  # ADD to pi's default (keeps tool-calling scaffolding)
      --no-skills                                 # drop GLOBAL skills…
      --no-context-files)                         # …and global ~/AGENTS.md / CLAUDE.md

# …then add back this repo's skills, recursively — the CC domain skills AND the
# vendored obra/superpowers methodology skills (brainstorming, TDD, systematic
# debugging, …), so BOTH the orchestrator and the auto-researcher have them.
while IFS= read -r sk; do ARGS+=(--skill "$sk"); done \
  < <(find languages/skills -name SKILL.md -exec dirname {} \; | sort)

# Flags (any order): --restricted (sandbox to turtle_sim only), --json (stream
# line-delimited JSON events — reliable for headless/CI; text mode is buffered).
while [ $# -gt 0 ]; do
  case "$1" in
    --restricted) ARGS+=(--tools turtle_sim); shift ;;
    --json)       ARGS+=(--mode json); shift ;;
    *) break ;;
  esac
done

if ! curl -s -o /dev/null "http://127.0.0.1:8790/mcp" 2>/dev/null; then
  echo "warning: languages server not reachable on :8790 — start it first:" >&2
  echo "  MCP_V8_PORT=8790 MCP_V8_SESSION_DB_PATH=/tmp/mcp-v8-pi ./run-languages-mcp.sh &" >&2
fi

exec pi "${ARGS[@]}" "$@"
