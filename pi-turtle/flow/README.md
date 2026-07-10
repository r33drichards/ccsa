# turtle-research — a Temporal-backed MCP task server

The turtle **researcher**, exposed as an MCP server. You hand it an **`arena.yaml`**
(a sim spec: a world plus invariant checks) and it runs a durable **Temporal**
workflow in which a sandboxed **glm** agent writes a CC:Tweaked Lua turtle program
and iterates against the arena's invariants until they all pass — then hands you
the program.

No orchestrator, no gist, no TUI. One input (`arena.yaml`), one output
(`prog.lua`), orchestrated by Temporal and pollable like a task.

## How this maps to what we built before

| before | now |
|---|---|
| `pilot.sh` (interactive pi TUI) | an MCP server — drive it from any MCP client |
| orchestrator + researcher + gist | **researcher only** |
| agent picks the arena | you pass the arena (`arena.yaml`) as the tool input |
| flaky, hard to observe | **Temporal**: durable, retried, visible in the dashboard |
| pi CLI | **pi TypeScript SDK** (headless, drives glm) |

## Architecture

```
MCP client ──stdio──> server.ts (MCP)
                         │  research_trigger({ arena })  ─> Temporal: start researchWorkflow
                         │  research_status({ workflowId }) ─> Temporal: describe/result
                         ▼
                    Temporal server (:7233, UI :8233)
                         ▼
                    worker.ts ── researchWorkflow ── research() activity
                                                        │ pi SDK (glm) + turtle_sim tool
                                                        ▼ run_sim.py → craftos sim (:8790)
```

- **server.ts** — MCP server (stdio). Tools + skill resources. Talks to Temporal.
- **worker.ts** — Temporal worker running the workflow + `research` activity.
- **workflow.ts** — `researchWorkflow(arena)` → `research(arena)`.
- **activities.ts** — `research(arena)`: the glm agent loop against the sim.
- **arena.ts** — deterministic arena generators (to *make* an `arena.yaml`).

## Run it

Three long-lived processes, then point an MCP client at the server:

```bash
# 1. Temporal dev server (durable execution + dashboard at http://localhost:8233)
temporal server start-dev --ui-port 8233 &

# 2. the craftos sim server
cd /Users/robertwendt/ccsa && MCP_V8_PORT=8790 MCP_V8_SESSION_DB_PATH=/tmp/mcp-v8-pi ./run-languages-mcp.sh &

# 3. the Temporal worker (needs OLLAMA_API_KEY from .env for glm)
cd /Users/robertwendt/ccsa && set -a; . .env; set +a
cd pi-turtle/flow && npx tsx worker.ts &
```

Register the MCP server with your client (e.g. `.mcp.json` / Claude Desktop):

```json
{ "mcpServers": { "turtle-research": {
    "command": "npx", "args": ["tsx", "/Users/robertwendt/ccsa/pi-turtle/flow/server.ts"] } } }
```

## Tools

- **`research_trigger({ arena })`** — `arena` is the full `arena.yaml` text. Starts a
  research job. Returns `{ workflowId, ui }` (the `ui` is a Temporal dashboard link).
- **`research_status({ workflowId })`** — poll it:
  - still working → `{ "type": "running" }`
  - success → `{ "type": "ok", "score": "54/54", "files": { "prog.lua": "<lua>" } }`
  - failure → `{ "type": "error", "msg": "...", "files": { "prog.lua": "<best>" } }`

## Resources (skills over MCP)

The turtle skills are served as MCP resources so a client can read the (abstract)
guidance the researcher uses:

- `skill://turtle-sorter`, `skill://turtle-crafter-compressor`,
  `skill://cc-tweaked`, `skill://craftos-sim`

## Making an arena.yaml

`arena.ts` generates the invariant arenas (compression or in-place sort):

```bash
npx tsx -e "import {genSortArena} from './arena.ts'; import {writeFileSync} from 'node:fs'; writeFileSync('arena.yaml', genSortArena())"
# or a compression arena:
npx tsx -e "import {genCompressArena} from './arena.ts'; import {writeFileSync} from 'node:fs'; writeFileSync('arena.yaml', genCompressArena({task:'compress',inputItem:'minecraft:iron_nugget',outputItem:'minecraft:iron_ingot',perCraft:9}))"
```

An `arena.yaml` is just a craftgen sim spec — a named `worlds` entry per environment whose
`test(sim)` asserts the invariants a correct turtle must satisfy. You can also
hand-write one.
# Shared turtle worlds

Arena environments may declare `turtles` to run multiple turtles against one
physical simulated world. The first turtle runs the generated program unless it
has a fixed `program`; partner turtles use fixed programs. Helper `nodes` remain
plain computers unless they set `world: "shared"` and a `start` position.

At the raw `craftos()` layer, define top-level `worlds` and reference one by name
from each turtle node. References share blocks, chests, world diffs, turtle
occupancy, and adjacent turtle inventories. Turtle nodes must use named worlds.
