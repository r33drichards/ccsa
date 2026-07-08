// Temporal activities for the Temporal-native researcher (pi removed). The WORKFLOW
// owns the agentic loop + message history (durable via event replay); these activities
// are the non-deterministic I/O it dispatches:
//   openSandbox  - open the mcp-js languages session + seed engine/skills into /work
//   callLlm      - one glm completion (Ollama OpenAI-compatible API) with the tools
//   turtleSim    - run the submitted Lua against the arena via mcp-js (the state mutation)
//   runJs        - raw run_js passthrough, so the agent can inspect the sandbox itself
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApplicationFailure, Context, heartbeat } from "@temporalio/activity";
import * as lang from "./mcp-languages.ts";
import { validatorFromWorkCode, parseSim, skillSeedFiles, WORK_PROG, type SimResult } from "./sim.ts";
import * as comp from "./compaction.ts";
import { recordTokens, recordCall, emitLog } from "./telemetry.ts";
import type { Env } from "./arena-object.ts";

// this activity's Temporal workflow id, for tagging logs so a run's LLM output is
// filterable per-workflow in Grafana/Loki. "" outside an activity context (e.g. tests).
function wfId(): string {
  try { return Context.current().info.workflowExecution.workflowId; } catch { return ""; }
}

// ── Ollama error classification (drives Temporal retry) ─────────────────────
// The provider fails intermittently; distinguish transient (retry) from permanent (fail fast)
// and always attach an actionable message so the workflow's FAILED reason is legible.
//
// A fetch rejection from undici is an opaque "fetch failed" TypeError — the useful detail
// (ENOTFOUND / ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT / the abort on our 14-min timeout)
// hides in e.cause. Surface it, then rethrow as a plain Error so Temporal RETRIES it.
function networkError(what: string, url: string, e: any): Error {
  const code = e?.cause?.code || e?.code || e?.name || "unknown";
  const detail = e?.cause?.message || e?.message || String(e);
  return new Error(`${what}: cannot reach Ollama at ${url} (${code}: ${detail}) — transient, retrying`);
}

// Turn a non-2xx HTTP response into the right kind of failure. 4xx (except 429) is a client
// error — a bad OLLAMA_API_KEY or malformed request won't fix itself, so throw NON-RETRYABLE
// to fail the workflow immediately with a clear cause. 5xx / 429 are transient -> plain Error
// (Temporal retries).
function httpError(what: string, url: string, status: number, body: string): Error {
  const msg = `${what}: Ollama ${status} at ${url} — ${body.slice(0, 300)}`;
  if (status >= 400 && status < 500 && status !== 429)
    return ApplicationFailure.nonRetryable(`${msg} (client error — check OLLAMA_API_KEY / request; not retrying)`, "LlmClientError");
  return new Error(`${msg} (server/rate-limit — retrying)`);
}

const REPO = join(import.meta.dirname, "..", "..");
const LANG_URL = `http://127.0.0.1:${process.env.TURTLE_PORT || "8790"}/mcp`;
const OLLAMA_BASE = (() => {
  try { return JSON.parse(readFileSync(join(REPO, "pi-turtle", "agent", "models.json"), "utf8")).providers.ollama.baseUrl; }
  catch { return "https://ollama.com/v1"; }
})();

// open a languages connection bound to this workflow's persistent /work
async function conn(workSession: string): Promise<lang.Conn> {
  return lang.open(LANG_URL, workSession);
}

// Seed the craftos engine + full skills tree into /work (once per workflow run).
export async function openSandbox(workSession: string): Promise<{ seeded: number }> {
  const files = skillSeedFiles();
  const c = await conn(workSession);
  await lang.seed(c, files);
  return { seeded: Object.keys(files).length };
}

export type LlmOut = { content: string; toolCalls: { id: string; name: string; arguments: string }[]; tokens: number };

// One completion, STREAMED. Env access is allowed in activities; Temporal owns retries.
// We stream (stream:true + include_usage) so the assistant's text is tee'd to Loki as it
// generates — tagged with the Temporal workflow id + step, so a run's reasoning is watchable
// live in Grafana (Explore -> Loki: {service_name="turtle-research"} | workflow_id="turtle-…").
// This also makes a slow completion visibly distinguishable from a hung one. Token usage
// arrives in the final SSE chunk (verified include_usage is honored), so accounting is intact.
export async function callLlm(input: { messages: unknown[]; tools: unknown[]; model: string; step?: number }): Promise<LlmOut> {
  const key = process.env.OLLAMA_API_KEY;
  const model = process.env.TURTLEFLOW_MODEL || input.model || "glm-5.2";
  if (!key) throw ApplicationFailure.nonRetryable("callLlm: OLLAMA_API_KEY not set", "LlmClientError");
  const url = `${OLLAMA_BASE}/chat/completions`;
  const step = input.step ?? 0;
  const attrs = { workflow_id: wfId(), kind: "llm", step };
  // Fail FAST when Ollama is unavailable, without cutting off a genuinely long (but steadily
  // streaming) completion. Three phases on one AbortController, so we distinguish "service not
  // responding" from "slow response":
  //   * HEADER_MS  — no response headers by then ⇒ the service isn't responding (down / overloaded
  //                  / hanging TCP) ⇒ abort in ~60s instead of blocking the full 14 min.
  //   * IDLE_MS    — the stream stalled (no chunk) ⇒ mid-generation hang; still allows slow-but-
  //                  progressing output because the timer resets on every chunk.
  //   * OVERALL_MS — hard backstop just under the 15-min activity ceiling.
  // Every abort surfaces as a retryable networkError, so Temporal cycles its retries ~14x faster
  // during an outage instead of burning 14 min per attempt.
  const HEADER_MS = 60_000, IDLE_MS = 300_000, OVERALL_MS = 3_300_000; // idle 5min = the heartbeatTimeout; overall 55min < 60min cap
  const ac = new AbortController();
  const overall = setTimeout(() => ac.abort(new DOMException(`no completion within ${OVERALL_MS / 1000}s`, "TimeoutError")), OVERALL_MS);
  let phase = setTimeout(() => ac.abort(new DOMException(`no response headers within ${HEADER_MS / 1000}s — Ollama unavailable`, "TimeoutError")), HEADER_MS);
  const clearAll = () => { clearTimeout(overall); clearTimeout(phase); };
  const bumpIdle = () => { clearTimeout(phase); phase = setTimeout(() => ac.abort(new DOMException(`stream stalled — no data for ${IDLE_MS / 1000}s (Ollama unavailable)`, "TimeoutError")), IDLE_MS); };
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: input.messages, tools: input.tools, tool_choice: "auto", temperature: 0, stream: true, stream_options: { include_usage: true } }),
      signal: ac.signal,
    });
  } catch (e) { clearAll(); recordCall("completion", model, "error"); throw networkError("callLlm", url, e); }
  bumpIdle(); // headers arrived — switch from the header deadline to the per-chunk idle deadline
  if (!r.ok) { clearAll(); recordCall("completion", model, "error"); throw httpError("callLlm", url, r.status, await r.text()); }
  if (!r.body) { clearAll(); recordCall("completion", model, "error"); throw new Error("callLlm: streaming response had no body"); }

  // parse the OpenAI SSE stream: accumulate assistant content + reassemble tool_call
  // fragments (which arrive split across deltas, keyed by index), teeing text to Loki.
  emitLog("info", `[step ${step}] llm call started (${model})`, attrs);
  // glm-5.2 is a REASONING model: its chain-of-thought streams in delta.reasoning while
  // delta.content stays empty until a final answer / tool call. Capture BOTH — content+toolCalls
  // are the actionable output (returned), reasoning is tee'd to Loki for observability (otherwise
  // the streamed logs are blank). Reasoning is NOT sent back in the message (not part of the
  // OpenAI message format), it's ephemeral thinking.
  let content = "", reasoning = "", emitted = 0, remitted = 0, usage: any = null, finish: string | null = null;
  const toolAcc: Record<number, { id: string; name: string; args: string }> = {};
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (final = false) => {
    if (content.length > emitted && (final || content.length - emitted >= 200)) {
      emitLog("info", content.slice(emitted), attrs); emitted = content.length;
    }
    if (reasoning.length > remitted && (final || reasoning.length - remitted >= 400)) {
      emitLog("info", reasoning.slice(remitted), { ...attrs, kind: "reasoning" }); remitted = reasoning.length;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bumpIdle();           // progress — reset the client stall deadline
      try { heartbeat(); } catch { /* not in an activity context (e.g. a local test) */ }
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j: any; try { j = JSON.parse(data); } catch { continue; }
        // a provider error can arrive as an SSE data event with HTTP 200 — surface it as a
        // retryable failure instead of silently yielding an empty completion (which the loop
        // would misread as the agent signalling "done").
        if (j.error) { clearAll(); recordCall("completion", model, "error"); throw new Error(`callLlm: provider error mid-stream — ${JSON.stringify(j.error).slice(0, 300)}`); }
        if (j.usage) usage = j.usage;
        const ch = j.choices?.[0];
        const d = ch?.delta;
        if (ch?.finish_reason) finish = ch.finish_reason;
        if (d?.content) content += d.content;
        // reasoning models expose CoT under `reasoning` (Ollama) or `reasoning_content` (zhipu/vLLM)
        if (d?.reasoning) reasoning += d.reasoning;
        else if (d?.reasoning_content) reasoning += d.reasoning_content;
        if (Array.isArray(d?.tool_calls)) for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          const acc = toolAcc[i] || (toolAcc[i] = { id: "", name: "", args: "" });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
        flush();
      }
    }
  } catch (e) { clearAll(); recordCall("completion", model, "error"); throw networkError("callLlm", url, e); }
  clearAll();
  flush(true);

  const toolCalls = Object.keys(toolAcc).map(Number).sort((a, b) => a - b)
    .map((i) => ({ id: toolAcc[i].id, name: toolAcc[i].name, arguments: toolAcc[i].args || "{}" }));
  // A completion with NO content AND NO tool calls is not actionable — a transient provider empty,
  // a reasoning-only stop, or (a known Ollama /v1 quirk) a DROPPED tool-call chunk despite
  // finish_reason="tool_calls". Retry rather than return empty, which the loop would misread as the
  // agent signalling "done" (-> checkCompleted -> "no program at /work/prog.lua yet", forever).
  if (!content.trim() && toolCalls.length === 0) {
    recordCall("completion", model, "error");
    emitLog("warn", `[step ${step}] empty completion (finish=${finish}, reasoning=${reasoning.length}c, tokens=${usage?.total_tokens ?? 0}) — retrying`, attrs);
    throw new Error(`callLlm: model produced no actionable output (finish_reason=${finish}, reasoning=${reasoning.length} chars) — retrying`);
  }
  recordTokens("completion", model, usage);
  recordCall("completion", model, "ok");
  if (toolCalls.length) emitLog("info", `[step ${step}] -> tool_calls: ${toolCalls.map((t) => t.name).join(", ")}`, attrs);
  return { content, toolCalls, tokens: usage?.total_tokens ?? 0 };
}

// ── compaction: the rolling-summary LLM activity ────────────────────────────
// Folds the evicted middle of the transcript into one progressive, structured record
// so the agent never forgets which invariants failed or which approaches it already
// tried+rejected. Non-deterministic (LLM), so it lives here as an activity; Temporal
// records the returned string, keeping workflow replay deterministic.
const SUMMARIZER_SYSTEM =
`You are the memory compactor for an autonomous agent that writes and debugs CC:Tweaked (Minecraft ComputerCraft) turtle Lua programs. Your ONLY job is to maintain a compact, LOSSLESS-ON-KEY-FACTS record of everything the agent has already tried, so it never repeats a failed approach or forgets which invariants are still failing. You are NOT solving the task and NOT writing Lua. You output ONLY the updated record in the exact template below — no preamble, no commentary.

Absolute rules:
- COPY VERBATIM, never paraphrase: invariant names, the exact "... FAIL ..." / "ok" lines from turtle_sim output, error strings, and any Lua you decide to retain. Paraphrasing a failing-invariant name or a coordinate destroys the record's only value.
- Carry forward every fact from PRIOR RECORD unless the NEW MESSAGES clearly supersede it (e.g. an invariant that was failing is now passing). Never silently drop a tried-and-rejected approach.
- If an approach appears in NEW MESSAGES, add it to APPROACHES TRIED with the specific reason it failed (which invariant(s) it broke). Deduplicate against approaches already listed.
- Keep the CURRENT BEST PROGRAM as the full Lua of the highest-scoring attempt seen so far (prior record vs. new messages — keep whichever scored higher). If unchanged, keep the prior one.
- Be terse everywhere EXCEPT the verbatim fields above. Target under ~600 words excluding the CURRENT BEST PROGRAM code block.

TEMPLATE (emit all headers, fill every field, keep this order):
GOAL: <one or two sentences, from the task>
HARD INVARIANTS: <comma-separated invariant names, verbatim>
INVARIANTS STILL FAILING:
- <invariant name> — <exact FAIL line from the most recent sim that failed it>
(list every currently-failing invariant; write "none known failing" if all seen passing)
APPROACHES TRIED & WHY REJECTED:
- <one line: what was tried> — broke: <invariant name(s)> / <error string, verbatim>
CURRENT BEST: score <x>/<total>
CURRENT BEST PROGRAM:
\`\`\`lua
<full Lua of the best attempt, verbatim, or the single line: (kept verbatim in recent tail)>
\`\`\`
NEXT-STEP HYPOTHESES: <bullet list of untried ideas / suspected root causes>`;

// render an OpenAI-shape message compactly for the summarizer's input
function renderMessages(msgs: any[]): string {
  return msgs.map((m) => {
    const parts: string[] = [String(m.role) + ":"];
    if (m.content) parts.push(String(m.content));
    if (Array.isArray(m.tool_calls) && m.tool_calls.length)
      parts.push("[tool_calls] " + m.tool_calls.map((tc: any) => `${tc.function?.name}(${tc.function?.arguments})`).join("; "));
    return parts.join(" ");
  }).join("\n\n");
}

export async function summarize(input: { oldSummary: string; evicted: any[]; task: string }): Promise<{ summary: string; tokens: number }> {
  const key = process.env.OLLAMA_API_KEY;
  const model = process.env.TURTLEFLOW_MODEL || "glm-5.2";
  if (!key) throw ApplicationFailure.nonRetryable("summarize: OLLAMA_API_KEY not set", "LlmClientError");
  const url = `${OLLAMA_BASE}/chat/completions`;
  const user =
    `PRIOR RECORD (may be empty on first compaction):\n<<<\n${input.oldSummary}\n>>>\n\n` +
    `TASK (first user message, for GOAL/invariants grounding):\n<<<\n${input.task}\n>>>\n\n` +
    `NEW MESSAGES being compacted (oldest agent turns being evicted from live context; assistant text, tool_calls with their Lua/JS arguments, and turtle_sim / run_js tool results):\n<<<\n${renderMessages(input.evicted)}\n>>>\n\n` +
    `Output the updated record now, template only.`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: SUMMARIZER_SYSTEM }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(840000), // 14 min, just under the 15-min activity ceiling
    });
  } catch (e) { recordCall("summarize", model, "error"); throw networkError("summarize", url, e); }
  if (!r.ok) { recordCall("summarize", model, "error"); throw httpError("summarize", url, r.status, await r.text()); }
  const j: any = await r.json();
  recordTokens("summarize", model, j.usage);
  recordCall("summarize", model, "ok");
  return { summary: (j.choices?.[0]?.message?.content ?? "").trim(), tokens: j.usage?.total_tokens ?? 0 };
}

// compact: the WHOLE rolling-summary compaction as one activity (the workflow calls this only
// when its cheap deterministic gate trips). Picks the verbatim tail on tool-pair-safe group
// boundaries, folds the evicted middle into the rolling summary via one or more summarize LLM
// calls, and returns the new message list + summary + tokens spent. Returns messages unchanged
// if there is nothing evictable.
export async function compact(input: { messages: any[]; summary: string; task: string; toolsSchemaTok: number }): Promise<{ messages: any[]; summary: string; tokens: number }> {
  let messages = input.messages.slice();
  let summary = input.summary;
  let tokens = 0;
  const groups = comp.groupsFrom(messages, 2);
  if (groups.length === 0) return { messages, summary, tokens };
  // 1) verbatim tail: walk whole groups backward until the token budget / min-groups floor
  let acc = 0, kept = 0, tailStart = messages.length;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    let gTok = 0; for (let k = g.start; k < g.end; k++) gTok += comp.estMsg(messages[k]);
    if (kept >= comp.MIN_TAIL_GROUPS && acc + gTok > comp.TAIL_TOKEN_BUDGET) break;
    acc += gTok; kept++; tailStart = g.start;
  }
  // 2) fold the evicted middle into the rolling summary
  const evicted = messages.slice(2, tailStart);
  if (evicted.length > 0) {
    const sum = await summarize({ oldSummary: summary, evicted, task: input.task });
    summary = sum.summary; tokens += sum.tokens;
    messages = [messages[0], messages[1], ...messages.slice(tailStart)];
  }
  // 3) if the tail alone still exceeds target, fold its oldest groups one at a time (keep a min tail)
  while (comp.estTokens(comp.sendView(messages, summary), input.toolsSchemaTok) > comp.COMPACT_TARGET) {
    const g = comp.groupsFrom(messages, 2);
    if (g.length <= comp.MIN_TAIL_GROUPS) break;
    const chunk = messages.slice(2, g[0].end);
    const sum = await summarize({ oldSummary: summary, evicted: chunk, task: input.task });
    summary = sum.summary; tokens += sum.tokens;
    messages = [messages[0], messages[1], ...messages.slice(g[0].end)];
  }
  return { messages, summary, tokens };
}

export type SimObs = SimResult & { observation: string };

// The env-fault message the agent sees when the SIM ENGINE (not its Lua) is down. It is
// deliberately blunt: "do not rewrite your program" — because the failure mode we are
// guarding against is exactly the agent misreading an engine crash as its own bug and
// burning turns rewriting correct Lua (turtle-inher87j).
const ENGINE_DOWN_MSG =
  "⛔ SIM ENGINE UNAVAILABLE — the simulator itself failed to load/run; this is an ENVIRONMENT " +
  "fault, NOT a bug in your Lua. Rewriting your program will NOT help. The sandbox /work or the " +
  "craftos engine is missing (bootstrap/ENOENT/undefined). The run harness must repair the sandbox.";

function observe(res: SimResult): string {
  if (res.envError) return ENGINE_DOWN_MSG + (res.output ? "\n" + res.output.slice(0, 800) : "");
  const head = res.total > 0 ? `score: ${res.score}/${res.total}${res.passed ? "  ✅ ALL PASS (0 failed)" : ""}` : "score: 0 (program errored at runtime — see log)";
  const fails = res.failures.length ? "\nfailing invariants:\n" + res.failures.map((f) => "  " + f).join("\n") : "";
  const log = res.total === 0 && res.output ? "\n" + res.output.slice(0, 1500) : "";
  return head + fails + log;
}

// Preflight / on-demand SIM ENGINE health check. Loads the seeded bootstrap and asserts
// `craftos` came into scope as a function — the minimal, false-positive-safe signal that
// the engine can run at all. We deliberately do NOT run a full craftos({nodes}) here: a
// world/program typo could false-negative and fail otherwise-healthy runs. This precisely
// catches the observed faults (bootstrap ENOENT, /work vanished, `craftos is not defined`)
// without that risk. Returns {ok:false, detail} so the workflow can fail fast with a
// distinct, legible cause instead of grinding to maxSteps on 0/0 sims.
export async function checkEngine(input: { workSession: string }): Promise<{ ok: boolean; detail: string }> {
  const c = await conn(input.workSession);
  const probe =
    `try { (0,eval)(await fs.readFile(${JSON.stringify(lang.WORK_BOOTSTRAP)},'utf8')); ` +
    `console.log(typeof craftos === 'function' ? 'ENGINE_OK' : ('ENGINE_BAD: craftos is ' + typeof craftos)); } ` +
    `catch (e) { console.log('ENGINE_ERR: ' + (e && e.message ? e.message : String(e))); }`;
  let text: string;
  try { text = (await lang.runJs(c, probe)).trim(); }
  catch (e) { return { ok: false, detail: `engine probe could not run: ${String(e).slice(0, 300)}` }; }
  const ok = text.includes("ENGINE_OK");
  return { ok, detail: ok ? "craftos engine loaded" : `engine probe failed: ${text.slice(0, 400)}` };
}

// writeProg: deterministic keep-or-revert. Overwrite /work/prog.lua with a program — the
// workflow uses this to restore the best-so-far after a regressing turtle_sim, so the
// canonical program (and the final deliverable) never drops below the best score.
export async function writeProg(input: { workSession: string; program: string }): Promise<{ ok: true }> {
  const c = await conn(input.workSession);
  await lang.runJs(c, `await fs.writeFile(${JSON.stringify(WORK_PROG)}, ${JSON.stringify(input.program)}); console.log('reverted ' + ${JSON.stringify(input.program.length)} + ' bytes');`);
  return { ok: true };
}

// turtle_sim: the state MUTATION — write the program to /work/prog.lua (single source
// of truth), then run it against every env. Returns the sim result as the agent's
// self-test observation. The submitted program (tool INPUT) and the observation (tool
// OUTPUT) are tee'd to Loki, tagged by workflow_id + step, so a run's tool activity is
// fully visible alongside its reasoning.
export async function turtleSim(input: { workSession: string; program: string; envs: Env[]; step?: number }): Promise<SimObs> {
  const attrs = { workflow_id: wfId(), kind: "tool", tool: "turtle_sim", step: input.step ?? 0 };
  emitLog("info", `[step ${input.step ?? 0}] turtle_sim INPUT (program):\n${input.program.slice(0, 6000)}`, attrs);
  const c = await conn(input.workSession);
  await lang.runJs(c, `await fs.writeFile(${JSON.stringify(WORK_PROG)}, ${JSON.stringify(input.program)}); console.log('wrote ' + ${JSON.stringify(input.program.length)} + ' bytes');`);
  const res = parseSim(await lang.runJs(c, validatorFromWorkCode(input.envs)));
  const observation = observe(res);
  emitLog("info", `[step ${input.step ?? 0}] turtle_sim OUTPUT:\n${observation.slice(0, 4000)}`, attrs);
  return { ...res, observation };
}

// check_completed: the DETERMINISTIC VALIDATOR that gates the loop (validator-in-the-
// loop). Runs /work/prog.lua against every env and reports whether the task is truly
// complete — the agent cannot end the loop by merely declaring success.
export async function checkCompleted(input: { workSession: string; envs: Env[] }): Promise<{ complete: boolean; feedback: string; score: number; total: number; program: string }> {
  const c = await conn(input.workSession);
  const text = await lang.runJs(c, validatorFromWorkCode(input.envs));
  if (text.includes('"status":"missing"')) {
    return { complete: false, score: 0, total: 0, program: "",
      feedback: "VALIDATOR: no program at /work/prog.lua yet. Submit your COMPLETE Lua program to turtle_sim (it writes the file); the deterministic validator runs it every turn and gates completion." };
  }
  const res = parseSim(text);
  // return the actual program the validator ran, so best.program always matches best.score
  const program = (await lang.runJs(c, `console.log(await fs.readFile(${JSON.stringify(WORK_PROG)},'utf8').catch(()=>''))`)).trim();
  // engine down: don't tell the agent its program failed — tell it the sandbox is broken.
  if (res.envError)
    return { complete: false, score: 0, total: 0, program,
      feedback: ENGINE_DOWN_MSG + "\n" + res.output.slice(0, 800) };
  const feedback = res.passed
    ? `VALIDATOR: SIM_RESULT: PASS — all ${res.total} invariants met. Task complete.`
    : `VALIDATOR (deterministic; ran your /work/prog.lua against every environment): ${res.score}/${res.total} invariants passed.` +
      (res.failures.length ? "\n" + res.failures.map((f) => "  " + f).join("\n") : "") +
      (res.total === 0 ? "\n(program errored at runtime)\n" + res.output.slice(0, 1200) : "") +
      "\nYou are NOT done until 0 failed. Revise the program and resubmit it via turtle_sim.";
  return { complete: res.passed, feedback, score: res.score, total: res.total, program };
}

// run_js: raw sandbox passthrough for the agent's own inspection. The code (tool INPUT)
// and its output are tee'd to Loki, tagged by workflow_id + step.
export async function runJs(input: { workSession: string; code: string; step?: number }): Promise<{ text: string }> {
  const attrs = { workflow_id: wfId(), kind: "tool", tool: "run_js", step: input.step ?? 0 };
  emitLog("info", `[step ${input.step ?? 0}] run_js INPUT (code):\n${input.code.slice(0, 6000)}`, attrs);
  const c = await conn(input.workSession);
  const text = (await lang.runJs(c, input.code)).slice(0, 8000);
  emitLog("info", `[step ${input.step ?? 0}] run_js OUTPUT:\n${text.slice(0, 4000)}`, attrs);
  return { text };
}
