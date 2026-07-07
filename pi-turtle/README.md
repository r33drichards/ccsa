# pi-turtle

A purpose-built [pi](https://pi.dev) package for making **CC:Tweaked turtle
programs** by autoresearching them against the craftos sim. The agent writes a
Lua program, tests it with the `turtle_sim` tool, reads the failing assertions,
and iterates until every sim postcondition passes.

## Quickstart

**1. Start the languages sim server** (self-hosted; has the `turtle.craft` +
op-budget engine):

```bash
MCP_V8_PORT=8790 MCP_V8_SESSION_DB_PATH=/tmp/mcp-v8-pi ./run-languages-mcp.sh &
```

**2. Pilot it** (run in a real terminal — pi is a TUI):

```bash
./pi-turtle/pilot.sh                # Turtlewright + repo skills + file tools + turtle_sim
./pi-turtle/pilot.sh --restricted   # sandbox: ONLY turtle_sim (no bash/edit/write)
```

Then tell it what turtle to build, e.g. *"Make a melon-compressor turtle: pull
slices from the chest above, craft 9→1 into melon blocks, drop them below.
Iterate with turtle_sim until 5/5."* It loops on its own until the score is maxed.

## Prerequisites (one-time)

- `pi` installed: `npm install -g @earendil-works/pi-coding-agent`
- Extension deps: `cd pi-turtle && npm install` (installs `typebox`)
- `.env` at the repo root with `OLLAMA_API_KEY=...` (Ollama Cloud; loaded by
  `pilot.sh`). The provider is defined in `pi-turtle/agent/models.json`.

## What makes it purpose-built

`pilot.sh` runs pi in an **isolated** config so none of your global setup bleeds in:

| lever | effect |
|---|---|
| `PI_CODING_AGENT_DIR=pi-turtle/agent` | isolated provider/models; global extensions don't load |
| `--no-skills` + `--skill languages/skills/*` | drops global skills, loads only this repo's CC domain skills (`cc-tweaked`, `craftos-sim`, `turtle-*`, `picat`, …) |
| `--no-context-files` | no global `~/AGENTS.md` / `CLAUDE.md` |
| `--system-prompt pi-turtle/system.md` | boots as **Turtlewright**, pre-briefed on the loop + crafting rules |
| `--restricted` → `--tools turtle_sim` | sandbox sub-agent: its only capability is submitting programs to the sim |

## The `turtle_sim` tool

Defined in `index.ts`. `turtle_sim(program)` writes the full Lua program to the
sim's `/work`, runs it against every sim node via the languages server, and
returns `score: N/total` plus the failing assertions. The engine's **op-budget**
means a non-terminating program aborts in seconds (scores low) instead of
hanging — see the mcp-js execution-timeout limitation this works around.

## Status

- ✅ Phase 2 (autoresearch loop): `turtle_sim` + the hang-proof sim — working.
- ⛔ Phase 1 (orchestrator to author a *new* sim interactively): not built; the
  sim spec is currently the fixed melon-compressor (`spike/melon-loop/spec.yaml`).
- ⛔ Phase 3 (`gh gist` publish of the passing program): not built.
