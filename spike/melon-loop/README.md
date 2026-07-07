# Spike: pi-autoresearch loop driven by the sandboxed sim tool

A light spike proving that **pi-autoresearch's measure/keep/revert loop can be
tuned to optimize a program using the mcp-v8 `run_js` tool as the measurement**,
with a real score gradient. Runnable today against the self-hosted languages
server; the pi/adapter wiring is documented below to drop in once `pi` is on the
box.

## What's here

```
spike/melon-loop/
  spec.yaml            # trimmed melon-compressor sim (2 nodes, 5 postconditions)
  prog.lua             # the program pi-autoresearch optimizes (starts naive)
  bin/run_sim.py       # the bridge: ship prog.lua into /work, run the sim via
                       #   run_js over the local server, print metric = #passed
  .auto/
    prompt.md          # objective + scope (the pi-autoresearch session doc)
    measure.sh         # metric script: echoes the bare integer to maximize
```

## Proven (self-hosted server, no pi required)

Start the server (own session DB so it never fights another instance's lock):

```bash
MCP_V8_PORT=8791 MCP_V8_SESSION_DB_PATH=/tmp/mcp-v8-spike ./run-languages-mcp.sh &
```

Then `spike/melon-loop/.auto/measure.sh` scores the current `prog.lua`:

| prog.lua | metric | note |
|---|---|---|
| naive (drain only)                      | **1/5** | starting point |
| partial (crafts+deposits, no leftovers) | **4/5** | one failing assertion pinpointed |
| full (validated compressor)             | **5/5** | `complete=True` |

The metric is monotone in program quality and the stderr `FAIL -` lines name
exactly what to fix — the gradient pi-autoresearch climbs.

## Wiring to actual pi (when installed)

1. **Bridge the sim as a pi tool** — install an MCP adapter and point it at the
   self-hosted server, exposing only `run_js`:

   ```bash
   pi install npm:pi-mcp-adapter
   ```
   `.mcp.json`:
   ```json
   { "mcpServers": { "languages": {
       "url": "http://127.0.0.1:8791/mcp", "lifecycle": "lazy",
       "directTools": ["run_js"] } } }
   ```

2. **Phase 1 (main session):** co-author `spec.yaml` + `.auto/` (a `craftgen-create`
   style skill). Main session keeps full tools.

3. **Phase 2 (sub-agent):** spawn a sub-agent restricted to the sandbox tool only
   — `pi.setActiveTools(["languages_run_js"])` (verify it sees adapter tool names;
   else `--exclude-tools bash,edit,write,read,grep,find,ls`). It edits `prog.lua`
   and re-measures until 5/5. `measure.sh` here is the reference measurement; in
   the pure-pi path the sub-agent can measure *through* `run_js` itself.

4. **Phase 3 (main session):** `gh gist create prog.lua spec.yaml .auto/log.jsonl`
   (main session has bash; `gh` is already authed here).

## Open items before productionizing

- Confirm pi-autoresearch's exact `measure.sh` stdout contract (this spike emits
  a bare integer on the last line; adjust if it wants JSON / a named metric).
- Decide host-file vs sandbox-`/work` ownership of `prog.lua` if the sub-agent is
  hard-restricted to `run_js` (then it writes to `/work` and the main session
  pulls the winner out via `/api/fs` or a `run_js` read).
