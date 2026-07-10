# ccsa — naive multi-MCP mini-swe-agent (Ollama Cloud) + languages sandbox

`main.py` is a small, generic agent loop: point it at one or more MCP servers
(Streamable HTTP), it unions their tools into one action space and loops
(model → tool calls → results → repeat) until the model answers with no tool
call. The LLM runs on **Ollama Cloud**.

## Quick start

```bash
export OLLAMA_API_KEY=...            # https://ollama.com/settings/keys

# generic: connect to any MCP server(s)
uv run main.py --server files=https://host/mcp --task "..."

# languages preset: picat + craftos WASM sim, with skills
uv run main.py --languages --task "Simulate two ComputerCraft computers talking over rednet."
```

## The languages preset (`--languages`)

Bundled under `languages/` is the mcp-js **languages** stack — an `mcp-v8`
`run_js` server with the **picat** (logic/constraint) and **craftos**
(CC:Tweaked emulator) WASM engines, plus a `skills/` library. With
`--languages`, `main.py`:

1. **loads the MCP server** — spawns `run-languages-mcp.sh` (mcp-v8 over
   Streamable HTTP at `http://127.0.0.1:8080/mcp`) and connects to it;
2. **inlines every `SKILL.md`** under `languages/skills/` into the system
   prompt, so the model always knows which skills exist and how to use them;
3. **exposes the rest of each skill** (`references/`, `scripts/`, `assets/`) —
   the whole `skills/` tree is seeded into the isolated sandbox at
   `/work/skills/`, so the agent reads them on demand with `run_js` →
   `fs.readFile('/work/skills/<name>/...')`.

The sandbox is fully isolated (no `--fs-passthrough`); everything lives in the
virtual `/work`, which persists across calls because the connection carries a
per-run `X-MCP-Session-Id` (mcp-v8's persistent per-session filesystem key). See
[docs/how-it-works.md](docs/how-it-works.md) for the two-session-header gotcha.

The agent uses the engines by loading the bootstrap and calling a helper in a
single `run_js` call:

```js
(0,eval)(await fs.readFile('.../languages/bootstrap.js','utf8'));
console.log(JSON.stringify(await craftos({nodes:[
  {label:'c1', collect:true, program:"emit('hi') emit(2+3) done()"}]})));
```

## craftgen — validator-in-the-loop program generation

`craftgen.py` makes an agent **write a CC:Tweaked program that provably passes a
test**, using the [validator-in-the-loop pattern](https://robertwendt) — the
agent doesn't get to *declare* success; a deterministic validator runs the sim
after every turn and only lets the loop finish on `SIM_RESULT: PASS`.

You declare, in one spec file, a CraftOS sim with a `world.test(sim)`
postcondition (see the `craftos-sim` skill), and mark where the agent's
program(s) go with a read-path sigil `program: "@file:NAME"`:

```yaml
task: >-
  Write a turtle program that digs the block in front and returns to start.
sim:
  timeout_ms: 15000
  worlds:
    mine_world: |
      return {
        blocks = { ['0,64,1'] = 'minecraft:stone' },
        test = function(sim)
          sim.assertBlock(0,64,1, nil, 'front block mined')
          sim.assertPos(0,64,0, 'returned to start')
        end
      }
  nodes:
    - label: rover
      collect: true
      program: "@file:turtle.lua"        # <- the agent authors this
      world: mine_world
      start: { x: 0, y: 64, z: 0, facing: south, fuel: 100 }
```

```bash
export OLLAMA_API_KEY=...
uv run craftgen.py examples/mine-forward.yaml            # exits 0 on PASS, 1 otherwise
uv run craftgen.py examples/tunnel.yaml --max-steps 12
```

How it works: the agent writes each `@file:NAME` program into the sandbox
filesystem at `/work/NAME` (`run_js` → `fs.writeFile`); after every turn the
validator reads the file(s) back, runs the sim, and gates on `SIM_RESULT: PASS`.
On failure the sim's assertion log is fed back to steer the next attempt.
Multiple `@file:` nodes = multiple programs the agent controls.

The bundled `sim/craftos2` harness also includes a farming regression test (`sim/test-farming.sh`) covering moist farmland inspection, wheat seed planting, and mature wheat harvest semantics.

**Isolation:** the languages server runs **without `--fs-passthrough`**, so the
sandbox cannot touch the real host disk — `/work` is all it can see. `/work`
persists across `run_js` calls because the connection sends a fresh per-run
`X-MCP-Session-Id` (mcp-v8's persistent per-session filesystem key — note this is
a *different* header from the MCP-standard `Mcp-Session-Id`; see
[docs/how-it-works.md](docs/how-it-works.md)). The harness seeds
`/work/bootstrap.js` (and the skills tree) once at startup; no snapshot
bookkeeping.

**CLI or webhook:** the business logic is `run_taskspec(spec, conn, http,
client, ...)` in `craftgen.py` — pure of argv/exit — so a webhook handler can
call it exactly as the CLI does. For testing, use the CLI.

## Dependencies

- **Ollama Cloud** account + `OLLAMA_API_KEY`.
- **`uv`** — runs `main.py` with its inline deps (`ollama`, `httpx`).
- **`mcp-v8`** — the run_js server, provided by nix via `flake.nix` (input
  `github:r33drichards/mcp-js`). The launcher resolves it in this order:
  `$MCP_V8_BIN` → `mcp-v8`/`server` on `PATH` → `nix run .#mcp-v8`.
- **`node`** — used once to build `languages/bootstrap.js` (already built and
  committed; rebuilt automatically if missing).

Enter a shell with everything on PATH:

```bash
nix develop        # mcp-v8 + node + uv
```

## Layout

```
main.py                 # the mini agent (generic multi-MCP loop)
craftgen.py             # validator-in-the-loop: generate a CC program that passes a sim test
examples/               # declarative craftgen task specs
run-languages-mcp.sh    # launches mcp-v8 (picat + craftos) over Streamable HTTP
fetch-mcp-v8.sh         # downloads the prebuilt mcp-v8 binary
flake.nix               # optional: build mcp-v8 from source / dev shell
languages/
  engines/              # picat.wasm, craftos.wasm (+ glue, tla)
  src/                  # polyfills.js, helpers.js
  build-bootstrap.mjs   # builds bootstrap.js from the engine glue
  bootstrap.js          # generated: loads the engines into run_js
  skills/               # SKILL.md library (inlined) + references/scripts/assets (fs-read)
```
