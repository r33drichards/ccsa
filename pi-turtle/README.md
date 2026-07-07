# pi-turtle

An AI agent that **writes working CC:Tweaked turtle programs for you.** You
describe the turtle you want; the agent writes Lua, tests it against a simulator,
reads the failures, and keeps fixing it until every check passes.

It's a [pi](https://pi.dev) agent called **Turtlewright**, wired to a sandboxed
ComputerCraft simulator through one tool (`turtle_sim`).

---

## 1. One-time setup

```bash
# a) install the pi agent runtime
npm install -g @earendil-works/pi-coding-agent

# b) install this agent's dependencies
cd /Users/robertwendt/ccsa/pi-turtle && npm install && cd ..

# c) add your Ollama Cloud key (used by the agent's model, glm-5.2)
echo "OLLAMA_API_KEY=sk-..." > .env        # in the repo root
```

## 2. Start the simulator (leave it running)

The agent tests programs against a local sim server. Start it once:

```bash
MCP_V8_PORT=8790 MCP_V8_SESSION_DB_PATH=/tmp/mcp-v8-pi ./run-languages-mcp.sh &
```

## 3. Use it

### Interactive (recommended — watch it work)

```bash
./pi-turtle/pilot.sh
```

pi opens a chat. Describe your turtle, for example:

> Make a stationary crafting turtle: pull `minecraft:melon_slice` from the chest
> above, compress 9→1 into `minecraft:melon` blocks with `turtle.craft()`, drop
> the blocks into the chest below, and put leftover slices back above. Use
> `turtle_sim` to test, and keep iterating until the score is 5/5.

You'll see it call `turtle_sim`, get back `score: N/5` plus the failing
assertions, fix its program, and try again until it passes. The finished program
is written to `spike/melon-loop/prog.lua`.

Handy in-session keys: `/` commands, `ctrl+c`/`ctrl+d` to exit.

### Headless (one shot, for scripts/CI)

```bash
./pi-turtle/pilot.sh --restricted -p "Make a melon-compressor turtle (9 slices -> 1 block); iterate with turtle_sim until 5/5."
```

`-p` runs non-interactively and exits when done. `--restricted` locks the agent
to **only** the `turtle_sim` tool (no file/shell access) — the safe "just make
the turtle" sandbox. Drop `--restricted` to also give it read/edit/write.

Add `--json` to stream **line-delimited JSON** events (one per line) instead of
buffered text — reliable for logs/CI. Each `turtle_sim` result arrives as a
`tool_execution_end` event carrying the score, e.g.:

```bash
./pi-turtle/pilot.sh --restricted --json -p "Make a melon-compressor turtle." \
  | grep --line-buffered '"type":"tool_execution_end"'
```

## Modes at a glance

| command | tools the agent has |
|---|---|
| `./pi-turtle/pilot.sh` | `create_sim`, `create_sort_sim`, `turtle_sim`, `publish_gist` + read-only (`read`/`grep`/`find`/`ls`) — **no bash/edit/write**, so it can't shell out or write files, only work through the sim |
| `./pi-turtle/pilot.sh --restricted` | `turtle_sim` only (sandbox) |

The full-mode agent runs the whole flow from a plain-English request:

1. **`create_sim`** — turns "compress iron nuggets into ingots (9→1)" into the
   **arena** the turtle must solve: a battery of diverse environments (empty input,
   sub-batch amounts, large amounts, input scattered across many small stacks)
   checked with **invariants** (conservation, maximality, empty inventory, chest
   purity) rather than a hardcoded expected answer. Passing every environment is
   what forces a *robust* turtle. Works for any input→craft→output compression.
2. **`turtle_sim`** — iterate the program until every check passes.
3. **`publish_gist`** — upload `prog.lua` + `spec.yaml` to a GitHub gist (via `gh`,
   which must be authenticated) and return the URL.

Two task shapes are supported today, each with its own arena generator:
- **Compression** (`create_sim`): input → `turtle.craft()` → output.
- **In-place sorting** (`create_sort_sim`): consolidate + name-sort each adjacent
  chest (above, below, front) without moving items between chests.

Example prompts:
- *"Make a turtle that compresses `minecraft:iron_nugget` into `minecraft:iron_ingot` (9→1), then publish it."*
- *"Create an item-sort turtle that sorts the items in all adjacent chests in place."*

Both agents load this repo's skills (recursively from `languages/skills/`): the
CC:Tweaked domain skills (`cc-tweaked` API reference, `craftos-sim`,
`turtle-crafter-compressor`, …) **and** the vendored
[obra/superpowers](https://github.com/obra/superpowers) methodology skills
(`brainstorming`, `test-driven-development`, `systematic-debugging`, `writing-plans`,
…). Neither loads your global pi skills or `~/AGENTS.md`.

## How it works (short version)

- **`turtle_sim(program)`** (defined in `index.ts`) writes your full Lua program
  into the sim's `/work`, runs it against every sim world, and returns the score
  (postconditions passed) + failing assertions.
- The sim is the self-hosted `run-languages-mcp.sh` server. Its engine has a
  **turtle-op budget**, so a program that loops forever aborts in ~20s and scores
  low instead of hanging.
- `pilot.sh` runs pi in an isolated config (`PI_CODING_AGENT_DIR=pi-turtle/agent`)
  with the Ollama provider in `agent/models.json` and the Turtlewright briefing in
  `system.md`.

## Troubleshooting

- **"languages server not reachable on :8790"** — start the sim (step 2).
- **Agent replies but never calls `turtle_sim`** — make sure `pilot.sh` uses
  `--append-system-prompt` (it does); a full `--system-prompt` replace strips
  pi's tool-calling instructions.
- **The turtle task the agent works on** is currently fixed to the melon
  compressor (`spike/melon-loop/spec.yaml`). Authoring a *new* sim from chat
  (the orchestrator phase) isn't built yet.

## Scope

The generated sims cover **input → craft → output compression turtles** (any
item, any ratio, chest above or below). Other turtle shapes (mining, movement,
multi-step processing) would need new sim generators.
