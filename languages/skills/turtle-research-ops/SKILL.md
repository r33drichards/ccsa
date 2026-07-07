---
name: turtle-research-ops
description: Operations runbook for the deployed turtle-research stack — the Temporal-native researcher MCP on Railway (Postgres-backed Temporal + mcp-js sim). Use when triggering jobs, debugging a failed/stuck workflow, reading logs, changing infra, or redeploying.
---

# turtle-research — infrastructure runbook

The researcher turns an **arena** (a turtle task + invariant tests) into a **sim-verified
CC:Tweaked Lua turtle program**. It runs as a Temporal-native agent loop: the workflow owns
the loop + message history (durable via event replay); `callLlm` (glm via Ollama) and the
tool calls (`turtle_sim`, `run_js`) are activities; a deterministic `checkCompleted` validator
gates completion. Code lives in `pi-turtle/flow/`.

## Topology (Railway project `turtle-research`)

- Project id: `c9f517fd-e4fb-4e95-ae5a-07fb3097dc1f` · env `production`: `5d593849-0538-49ca-8221-2431e6b3bafa`

| service | id | what it is |
|---|---|---|
| **app** | `537da663-b9b1-4f22-b60b-36e80a0fda91` | one container: mcp-js languages sim (:8790) + Temporal **worker** (taskQueue `turtle`) + **MCP server** (:$PORT). Started by `pi-turtle/flow/start.sh`. |
| **temporal** | `601455f9-7344-466c-80b8-0a79fda1c8a4` | `temporalio/auto-setup:1.25.2`, gRPC at `temporal.railway.internal:7233` (no public domain) |
| **temporal-ui** | `58708d37-a456-4a11-ac2e-4931646c96fe` | `temporalio/ui:2.32.0` |
| **Postgres** | `b53e9a50-49ff-47ee-b3b9-5a89f6fcbfaf` | managed PG (persistent volume), backs Temporal |

Public URLs:
- MCP: `https://app-production-19ff.up.railway.app/mcp`
- Temporal dashboard: `https://temporal-ui-production-df12.up.railway.app`

Data flow: `MCP research_trigger` → start workflow on Postgres-backed Temporal → app worker
polls `turtle` → `callLlm`/`turtle_sim`/`run_js`/`checkCompleted` activities → sim-verified
`prog.lua` → `research_status` returns it.

## Using it

`research_trigger({ task, environments:[{ start?, chests?, recipes?, test }], timeoutMs? })`
returns `{ workflowId, ui }` immediately. Then poll `research_status({ workflowId })`:
`{type:'running'}` → `{type:'ok', score, files:{'prog.lua'}}` → or `{type:'error', msg, score,
total, attempts, files:{'prog.lua': <best attempt>}}`. `test` is a Lua snippet asserting
invariants (see the `craftos-sim` / `turtle-sorter` skills for the sim API).

MCP is StreamableHTTP; send `initialize` then `tools/call`. One-liner:
```bash
MCP=https://app-production-19ff.up.railway.app/mcp
curl -s -X POST "$MCP" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' >/dev/null
curl -s -X POST "$MCP" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"research_trigger","arguments":{"task":"...","environments":[{"test":"sim.assertPos(8,64,11,\"x\")"}]}}}' \
  | sed 's/\r//g' | grep -a '^data:' | sed 's/^data: //' | tail -1
```

## Debugging a failed / stuck workflow

1. **Status:** `research_status({workflowId})`. `type:'error', msg:'workflow FAILED'` = the
   workflow terminated (an activity exhausted retries or threw). `type:'running'` forever =
   likely no worker polling (see below).

2. **Find the failing activity** via the temporal-ui JSON API (no auth):
   ```bash
   UI=https://temporal-ui-production-df12.up.railway.app
   curl -s "$UI/api/v1/namespaces/default/workflows/<WF>/history" > /tmp/wf.json
   python3 -c "import json;d=json.load(open('/tmp/wf.json'));[print(e['eventId'],e['eventType']) for e in d['history']['events'][-8:]]"
   ```
   Look for `EVENT_TYPE_ACTIVITY_TASK_FAILED` and `EVENT_TYPE_WORKFLOW_EXECUTION_FAILED`; the
   `...FailedEventAttributes.failure.message` + `activityFailureInfo.activityType.name` +
   `retryState` tell you which activity died and why (`RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED`
   = it kept failing; `NON_RETRYABLE` = threw a non-retryable error).

3. **Worker logs** (the activity stdout): Railway logs for `app`, `deploy` stream. Lines are
   prefixed `[sim]` / `[worker]` / `[mcp]` (start.sh pipes each process to stdout). A healthy
   boot shows `[worker] running on taskQueue 'turtle'` → `state: 'RUNNING'` and, in the
   `temporal` logs, the `turtle` task queue `lifecycle: Started`.

## Known failure modes → fixes

- **`callLlm` TimeoutError / workflow FAILED on a hard task** — the transcript grew until glm's
  completion exceeded the timeout; retries with the same context just time out again.
  *Fixed* by **rolling-summary compaction** bound to glm-5.2's 976K window (`compactIfNeeded` in
  `workflow.ts`: a deterministic char-based token estimate triggers at `COMPACT_THRESHOLD`, evicts
  the middle on whole `assistant(tool_calls)+tool` group boundaries into a structured running
  summary via the `summarize` activity, and keeps a verbatim tail) + graceful degradation (a
  retry-exhausted `callLlm` returns best-so-far instead of failing) + a 6-min `callLlm` budget.
  Tuning knobs in `workflow.ts`: `WORKING_CAP`, `COMPACT_THRESHOLD`/`COMPACT_TARGET`,
  `TAIL_TOKEN_BUDGET`, `MIN_TAIL_GROUPS`. If glm-5.2's tag/window changes, update `MODEL_WINDOW`.
- **Activities stuck PENDING (never start)** — no worker polling `turtle`. The worker runs in
  the `app` container; `start.sh` **exits the container if any of sim/worker/MCP dies** so
  Railway restarts a fresh worker. Check `app` deploy logs for a crash loop; confirm the
  `[worker] running on taskQueue 'turtle'` line.
- **MCP returns 502 `x-railway-fallback`** — the `app` container is mid-restart (~a few s).
  Retry. Persistent 502 = crash loop; read `app` deploy logs.
- **temporal-ui crash `config file corrupted: yaml: line 26`** — a bad env var breaks the UI's
  templated `config/docker.yaml`. Do **not** set `TEMPORAL_CORS_ORIGINS=*` (bare `*` is invalid
  YAML). Remove it; keep only `TEMPORAL_ADDRESS` + `TEMPORAL_UI_PORT=8080`.
- **Postgres var references don't resolve** — Railway refs are service-name-sensitive: use
  `${{Postgres.PGUSER}}` / `PGPASSWORD` / `RAILWAY_PRIVATE_DOMAIN` (capital `Postgres`).
- **railway-agent `commitStagedChangesTool` errors "root: Required"** — a known bug. Its changes
  are **staged, not applied**; click **Deploy / Apply** in the Railway dashboard to finalize.
- **Agent writes `require('fs')` / `import fs` in `run_js` and gets trapped** — the sandbox has
  no module system; `fs`, `craftos`, `picat` are ready GLOBALS and require/import throw. Guidance
  lives in the `run_js` tool description (`tools.ts`) + the system prompt (`sim.ts`); strengthen it
  there if the model regresses.
- Switching Temporal's datastore (e.g. to Postgres) **wipes prior workflow history** — expected.

## Required env vars

- **app**: `OLLAMA_API_KEY`, `TEMPORAL_ADDRESS=temporal.railway.internal:7233`,
  `TEMPORAL_UI_URL=https://${{temporal-ui.RAILWAY_PUBLIC_DOMAIN}}` (needs the `https://`),
  `TURTLE_PORT` (default 8790), `PORT`. Skills are MCP **resources only** — do **not** set
  `SKILLS_AS_TOOLS`.
- **temporal** (auto-setup): `DB=postgres12`, `DB_PORT=5432`, `POSTGRES_USER/PWD/SEEDS` (from
  `Postgres`), `DBNAME=temporal`, `VISIBILITY_DBNAME=temporal_visibility`,
  `SKIP_SCHEMA_SETUP=false`, `ENABLE_ES=false`, `BIND_ON_IP=0.0.0.0`.
- **temporal-ui**: `TEMPORAL_ADDRESS=temporal.railway.internal:7233`, `TEMPORAL_UI_PORT=8080`.

## Redeploy

- **Code**: `git push origin main` → the `app` service rebuilds from `pi-turtle/flow/Dockerfile`
  (worker + sim + MCP restart together).
- **Infra** (services/vars): via the railway-agent, then **Deploy/Apply** in the dashboard
  (commit tool is broken).

## Local dev / smoke test

Start the sim: `MCP_V8_PORT=8790 ./run-languages-mcp.sh` (vendored `bin/mcp-v8`). The activities
are plain functions — call `openSandbox` / `turtleSim` / `checkCompleted` / `callLlm` directly
(needs `OLLAMA_API_KEY` for `callLlm`) with `TURTLE_PORT=8790` to exercise the whole path without
Temporal. See [[craftos-engine-and-local-sim]] for running the craftgen sim locally.
