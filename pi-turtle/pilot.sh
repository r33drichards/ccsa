#!/usr/bin/env bash
# Pilot the turtle-making tool: a PURPOSE-BUILT, isolated pi session.
#
#   ./pi-turtle/pilot.sh                 # ORCHESTRATOR (Opus): design the arena,
#                                        #   dispatch the researcher (solve), publish.
#                                        #   Tools: create_sim, create_sort_sim, solve,
#                                        #   publish_gist (+ read-only). No bash/edit/write.
#   ./pi-turtle/pilot.sh --restricted    # RESEARCHER (glm-5.2): turtle_sim + read-only.
#   ...  --json                          # stream line-delimited JSON events (reliable headless)
#
# Two models: the orchestrator runs on Opus (needs Anthropic auth — set
# ANTHROPIC_API_KEY in .env, or override with PILOT_ORCH_PROVIDER/PILOT_ORCH_MODEL);
# the researcher runs on Ollama glm-5.2. The orchestrator's `solve` tool spawns the
# researcher (this same script with --restricted). Isolation: PI_CODING_AGENT_DIR =
# pi-turtle/agent; --no-skills/--no-context-files drop global skills + ~/AGENTS.md,
# then this repo's skills (CC + obra/superpowers) are re-added. Prereq: the languages
# server on :8790.
set -euo pipefail
cd "$(dirname "$0")/.."                            # repo root
set -a; . ./.env; set +a                          # OLLAMA_API_KEY / ANTHROPIC_API_KEY
export PI_CODING_AGENT_DIR="$PWD/pi-turtle/agent" # isolated config

MODE=orchestrator
JSON=()
while [ $# -gt 0 ]; do
  case "$1" in
    --restricted) MODE=researcher; shift ;;
    --json)       JSON=(--mode json); shift ;;
    *) break ;;
  esac
done

BASE=(-a -e pi-turtle/index.ts
      --append-system-prompt "$(cat pi-turtle/system.md)"
      --no-skills --no-context-files "${JSON[@]}")
# this repo's skills (CC domain + obra/superpowers), recursively, for both roles
while IFS= read -r sk; do BASE+=(--skill "$sk"); done \
  < <(find languages/skills -name SKILL.md -exec dirname {} \; | sort)

if [ "$MODE" = researcher ]; then
  MODEL=(--provider ollama --model glm-5.2)
  TOOLS=(--tools turtle_sim,read,grep,find,ls)     # solve the arena; read-only for skills
else
  MODEL=(--provider "${PILOT_ORCH_PROVIDER:-anthropic}" --model "${PILOT_ORCH_MODEL:-opus}")
  TOOLS=(--tools create_sim,create_sort_sim,solve,publish_gist,read,grep,find,ls)
fi

if ! curl -s -o /dev/null "http://127.0.0.1:8790/mcp" 2>/dev/null; then
  echo "warning: languages server not reachable on :8790 — start it first:" >&2
  echo "  MCP_V8_PORT=8790 MCP_V8_SESSION_DB_PATH=/tmp/mcp-v8-pi ./run-languages-mcp.sh &" >&2
fi

exec pi "${MODEL[@]}" "${BASE[@]}" "${TOOLS[@]}" "$@"
