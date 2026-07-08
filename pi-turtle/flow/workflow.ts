// The researcher as a Temporal-native agent loop (mini-swe-agent MCP edition shape).
// The WORKFLOW owns the loop and the message history — durable via event replay, so a
// dead worker resumes exactly. The model's tool_calls are dispatched as activities:
//   turtle_sim -> turtleSim (run the program against the arena, the state mutation)
//   run_js     -> runJs     (raw sandbox inspection)
// Terminates when turtle_sim passes, the model stops calling tools, or max steps.
import { proxyActivities, workflowInfo, continueAsNew, ApplicationFailure, patched, setHandler, defineQuery } from "@temporalio/workflow";
import type * as acts from "./activities.ts";
import { TOOLS } from "./tools.ts";
import { estTokens, sendView, COMPACT_THRESHOLD, toolsSchemaTok } from "./compaction.ts";
import type { Env } from "./arena-object.ts";

const { openSandbox, turtleSim, checkCompleted, runJs, checkEngine, writeProg } = proxyActivities<typeof acts>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 6, initialInterval: "2 seconds", maximumInterval: "30 seconds" },
});
// callLlm + compact hit Ollama, which fails intermittently ("fetch failed"). Temporal
// retries the ACTIVITY in place (the workflow keeps its state and resumes — it does NOT
// restart). With the 60s header timeout surfacing "unavailable" fast and the 5-min
// heartbeat catching stalls, we don't need many retries to mask a long outage — 5 attempts
// (~1 min of backoff) rides out a brief blip, then a sustained failure surfaces legibly so
// the caller re-triggers. A network/5xx/429 error is retried; a 4xx client error (bad
// key/request) is thrown non-retryable and fails fast.
const RETRY = { maximumAttempts: 5, initialInterval: "2 seconds", backoffCoefficient: 2, maximumInterval: "60 seconds" } as const;
// callLlm STREAMS a reasoning model (glm-5.2): a single completion can think for many minutes.
// It HEARTBEATS on every streamed chunk, so liveness is governed by heartbeatTimeout — a NORMAL
// 5-min window that catches REAL errors (a stalled/hung stream → fail fast → retry). startToClose
// stays large ONLY as a backstop: it cannot be reset by heartbeats, so it must exceed the longest
// legit reasoning; it should essentially never fire (the 5-min heartbeat gate trips first).
const { callLlm } = proxyActivities<typeof acts>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "5 minutes",
  retry: RETRY,
});
const { compact } = proxyActivities<typeof acts>({
  startToCloseTimeout: "30 minutes", // non-streaming summarize; generous but bounded
  retry: RETRY,
});

const TOOLS_SCHEMA_TOK = toolsSchemaTok(TOOLS); // static tool-schema token cost, for the gate

export type ResearchInput = { task: string; envs: Env[]; systemPrompt: string; model?: string; maxSteps?: number; maxTokens?: number };
export type ResearchResult = { passed: boolean; score: number; total: number; program: string; attempts: number; steps: number; tokens: number; report: string };
type Best = { program: string; score: number; total: number; passed: boolean };
// one entry per program the agent tested (deterministic autoresearch log — see ledgerDigest)
type Experiment = { n: number; score: number; total: number; failing: string[] };
type LoopState = { messages: any[]; step: number; best: Best; attempts: number; opened: boolean; summary: string; tokens: number; lastObs: string; stall: number; ledger: Experiment[] };

// The compaction threshold used by pre-autoresearch histories. New executions compact at the
// full-window COMPACT_THRESHOLD (~702K); in-flight ones replay with this legacy value so the
// needsCompaction gate — which decides WHEN the compact activity runs — stays replay-stable.
const LEGACY_COMPACT_THRESHOLD = 112000;

// Live progress, exposed via a Temporal QUERY so research_status can show what a RUNNING
// job is actually doing (step, best score, tokens, most-recent validator result) instead
// of an opaque "running". A query is side-effect-free (adds no history commands), so this
// is fully backward-compatible — it even works for jobs already in flight, since the query
// runs against the current worker code.
export type Progress = { step: number; maxSteps: number; attempts: number; score: number; total: number; passed: boolean; tokens: number; stall: number; lastObs: string; phase: string };
export const progressQuery = defineQuery<Progress>("progress");

const COMPACT_EVERY = 30; // continue-as-new cadence, to bound Temporal event-history size

// ── env-collapse guardrail ──────────────────────────────────────────────────
// turtle-inher87j proved the sandbox can die MID-RUN (the /work snapshot vanished
// after ~5 healthy calls), after which EVERY tool result is an engine fault and the
// agent flails against a dead environment to maxSteps (1.9M tokens, 0/0 forever). A
// one-time preflight can't catch a mid-run collapse, so we also watch for a run of
// tool results that look like the engine is down, then CONFIRM with checkEngine before
// aborting — the confirmation makes a false positive (the agent's own throwing probe)
// harmless: we just reset and continue. We FAIL CLOSED (no auto re-seed): a lost /work
// means a fresh sandbox would silently drop the agent's prior artifacts, so surface a
// clean, legible failure and let the caller re-trigger rather than continue on a
// half-restored environment.
const EXPLORE_BUDGET = 5; // steps of exploration allowed before we force a first turtle_sim attempt
const STALL_PROBE = 6; // consecutive engine-down-looking tool results before we confirm+abort
const ENGINE_DOWN_RE =
  /SIM ENGINE UNAVAILABLE|\[execution failed\]|(?:craftos|picat)\s+is\s+not\s+defined|\/work[^\n]*ENOENT|ENOENT:\s*work/;

// A caller-facing narrative is built DETERMINISTICALLY at the end (no extra LLM call): it reuses
// the rolling summary (s.summary — an LLM-maintained "APPROACHES TRIED & WHY REJECTED / INVARIANTS
// STILL FAILING" record), the most recent validator observation (s.lastObs), and the outcome stats.
function stripBestProgram(summary: string): string {
  // the full program is returned separately in `program`; drop the big code block
  return summary.replace(/CURRENT BEST PROGRAM:\s*```lua[\s\S]*?```/g,
    "CURRENT BEST PROGRAM: (returned separately in the `program` field)").trim();
}
function buildReport(s: LoopState, reason: string): string {
  const solved = s.best.passed;
  const head = solved
    ? `SOLVED — all ${s.best.total} invariants pass (best ${s.best.score}/${s.best.total}) after ${s.attempts} sim attempts across ${s.step} steps (${s.tokens} tokens).`
    : `NOT SOLVED (${reason}) — best ${Math.max(s.best.score,0)}/${s.best.total} invariants after ${s.attempts} sim attempts across ${s.step} steps (${s.tokens} tokens).`;
  const parts = [head];
  if (!solved && s.lastObs) parts.push(`Most recent validator result:\n${s.lastObs}`);
  if (s.summary) parts.push(`What was attempted (progress record):\n${stripBestProgram(s.summary)}`);
  else if (s.ledger && s.ledger.length) parts.push(`Experiments ledger:\n${ledgerDigest(s)}`);
  else if (!solved) parts.push(`No experiments recorded.`);
  return parts.join("\n\n");
}

// The deterministic autoresearch "log": a compact, replay-stable digest of every program the
// agent has tested (built by the workflow from recorded turtle_sim results, NOT an LLM summary).
// Injected into context each turn as keep-what-works memory, and used in the report. Bounded
// (last N attempts) so it stays cheap.
function ledgerDigest(s: LoopState): string {
  if (!s.ledger || s.ledger.length === 0) return "";
  const best = Math.max(s.best.score, 0);
  const out: string[] = [
    `BEST SO FAR: ${best}/${s.best.total}${s.best.passed ? " — SOLVED ✅" : ""}. This program is kept as /work/prog.lua; a NEW program is only kept if it scores HIGHER, and a lower-scoring attempt is auto-reverted. Build ON the best — don't regress it.`,
    `Programs tested: ${s.ledger.length} (most recent last):`,
  ];
  for (const e of s.ledger.slice(-15)) {
    const reg = e.score < best ? " (regressed → reverted)" : "";
    const fails = e.failing && e.failing.length ? "  still-FAIL: " + Array.from(new Set(e.failing)).slice(0, 8).join(" | ") : "";
    out.push(`  #${e.n}: ${e.score}/${e.total}${reg}${fails}`);
  }
  out.push(`Test EVERY new idea with turtle_sim — that is the only way to make progress. Do NOT resubmit an approach already listed above; for each still-failing invariant, try a DIFFERENT root-cause hypothesis.`);
  return out.join("\n");
}

// cheap, deterministic gate (workflow-side, no transcript serialization); the actual eviction +
// summarization is the compact ACTIVITY, invoked only when this trips. `threshold` is passed in
// so pre-autoresearch histories can keep the legacy value (replay-stable command sequence).
function needsCompaction(s: LoopState, threshold: number): boolean {
  return estTokens(sendView(s.messages, s.summary), TOOLS_SCHEMA_TOK) >= threshold;
}

export async function researchWorkflow(input: ResearchInput, state?: LoopState): Promise<ResearchResult> {
  const model = input.model || "glm-5.2";
  const maxSteps = input.maxSteps ?? 500;
  const workSession = workflowInfo().workflowId; // stable across continue-as-new -> same /work

  let s: LoopState = state ?? {
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: `${input.task}\n\nBegin. Write the program and call turtle_sim to test it; read the failing invariants and iterate until it reports 0 failed.` },
    ],
    step: 0, best: { program: "", score: -1, total: 0, passed: false }, attempts: 0, opened: false, summary: "", tokens: 0, lastObs: "", stall: 0, ledger: [],
  };
  const maxTokens = input.maxTokens ?? 20_000_000; // default 20M token budget (0 would = unbounded)

  // Deterministic autoresearch orchestration (log-result + keep-or-revert + full-window
  // compaction), gated behind ONE patch marker so in-flight pre-deploy histories replay with the
  // legacy behavior. AUTORESEARCH is false only when replaying such an old history.
  const AUTORESEARCH = patched("autoresearch-v1");
  if (AUTORESEARCH && !s.ledger) s.ledger = []; // resumed pre-autoresearch state carries no ledger
  const compactAt = AUTORESEARCH ? COMPACT_THRESHOLD : LEGACY_COMPACT_THRESHOLD;

  // register the progress query up front so research_status can read live state immediately
  setHandler(progressQuery, (): Progress => ({
    step: s.step, maxSteps, attempts: s.attempts,
    score: Math.max(s.best.score, 0), total: s.best.total, passed: s.best.passed,
    tokens: s.tokens, stall: s.stall, lastObs: (s.lastObs || "").slice(0, 500),
    phase: !s.opened ? "starting" : s.best.passed ? "solved" : "iterating",
  }));

  if (!s.opened) {
    await openSandbox(workSession);
    // Preflight: fail fast (with a distinct cause) if the seeded engine can't even load,
    // instead of discovering it 1.9M tokens later. Catches the "seeding failed at start"
    // variant; the stall guardrail below catches the "collapsed mid-run" variant.
    // patched(): the checkEngine calls are NEW activities — gate them so in-flight
    // pre-deploy histories replay deterministically (patched()=false when replaying old
    // history that never recorded the marker) instead of failing their workflow task.
    if (patched("engine-guardrails-v1")) {
      const eng = await checkEngine({ workSession });
      if (!eng.ok) throw ApplicationFailure.nonRetryable(`sim engine preflight failed — sandbox is broken before any work began: ${eng.detail}`, "SimEngineUnavailable");
    }
    s.opened = true;
  }

  const done = async (): Promise<ResearchResult> => {
    // if we passed via a file the agent wrote directly (no turtle_sim), fetch the program
    if (s.best.passed && !s.best.program) {
      const p = await runJs({ workSession, code: `console.log(await fs.readFile('/work/prog.lua','utf8').catch(()=>''))` });
      s.best.program = p.text.trim();
    }
    const reason = s.best.passed ? "solved"
      : (maxTokens && s.tokens >= maxTokens) ? "token budget exhausted"
      : s.step >= maxSteps ? "reached max steps"
      : "stopped";
    return { passed: s.best.passed, score: Math.max(s.best.score, 0), total: s.best.total, program: s.best.program, attempts: s.attempts, steps: s.step, tokens: s.tokens, report: buildReport(s, reason) };
  };

  while (s.step < maxSteps) {
    if (maxTokens && s.tokens >= maxTokens) break; // token budget exhausted -> return best-so-far

    // bind to glm-5.2's window: cheap gate here, the eviction + summarization is the compact activity
    if (needsCompaction(s, compactAt)) {
      const r = await compact({ messages: s.messages, summary: s.summary, task: String(s.messages[1].content), toolsSchemaTok: TOOLS_SCHEMA_TOK });
      s.messages = r.messages; s.summary = r.summary; s.tokens += r.tokens;
    }

    // Measure discipline: agents reason-loop on hard tasks (200K+ tokens, 0 attempts), trying to
    // solve everything analytically. If the agent has explored for EXPLORE_BUDGET steps without EVER
    // calling turtle_sim, push it hard to submit a best-effort program NOW — empirical feedback (the
    // score + failing invariants) beats unbounded planning. Message-only (no activity) so it's
    // replay-safe. The autoresearch ledger's "test every idea" nudge only fires AFTER attempt #1;
    // this covers the gap before the first attempt.
    if (s.attempts === 0 && s.step >= EXPLORE_BUDGET) {
      s.messages.push({ role: "user", content: `⚠ You have taken ${s.step} steps and have NOT ONCE called turtle_sim. You cannot solve this by analysis alone. Stop planning and SUBMIT a best-effort COMPLETE Lua program to turtle_sim THIS TURN — the deterministic sim's score and failing-invariant list will teach you far more than more reasoning, and a partial score beats no attempt. Write the program now.` });
    }

    // callLlm failing after its retries means the LLM is unreachable (e.g. a network
    // "fetch failed" to Ollama) — a real infra failure, NOT a "did not pass" result. Let it
    // propagate so the workflow reports FAILED, instead of masking it as an empty best attempt.
    // (Budget/step exhaustion is the legitimate graceful path — see the while-condition + done().)
    const a: acts.LlmOut = await callLlm({ messages: sendView(s.messages, s.summary, AUTORESEARCH ? ledgerDigest(s) : undefined), tools: TOOLS, model, step: s.step });
    s.tokens += a.tokens;

    s.messages.push(a.toolCalls.length
      ? { role: "assistant", content: a.content, tool_calls: a.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) }
      : { role: "assistant", content: a.content });

    // dispatch each tool_call as an activity. turtle_sim self-validates (writes+runs the program);
    // run_js is legitimate exploration/inspection of the sandbox and engine.
    for (const tc of a.toolCalls) {
      let args: any = {};
      try { args = JSON.parse(tc.arguments || "{}"); } catch { /* malformed -> empty */ }
      let obs: string;
      try {
        if (tc.name === "turtle_sim") {
          s.attempts++;
          const program = String(args.program ?? "");
          const r = await turtleSim({ workSession, program, envs: input.envs, step: s.step });
          obs = r.observation;
          s.lastObs = r.observation; // most recent sim/validator feedback -> caller-facing report
          const improved = r.score > s.best.score;
          if (improved) s.best = { program, score: r.score, total: r.total, passed: r.passed };
          if (AUTORESEARCH) {
            // log-result: deterministic autoresearch ledger (workflow-owned, from the recorded result)
            s.ledger.push({ n: s.attempts, score: r.score, total: r.total, failing: r.failures });
            // keep-or-revert: a non-improving attempt is discarded — restore the canonical best
            // program to /work/prog.lua so the sandbox + deliverable never regress below best.
            if (!improved && s.best.program) {
              await writeProg({ workSession, program: s.best.program });
              obs += `\n[harness] this scored ${r.score}/${r.total}, not beating your best ${s.best.score}/${s.best.total} — /work/prog.lua has been reverted to your best. Build on THAT, not this attempt.`;
            }
          }
        } else if (tc.name === "run_js") {
          obs = (await runJs({ workSession, code: String(args.code ?? ""), step: s.step })).text || "(no output)";
        } else {
          obs = `unknown tool: ${tc.name}`;
        }
      } catch (e) {
        obs = `tool ${tc.name} failed (transient environment error): ${String(e).slice(0, 200)}. Try again.`;
      }
      s.messages.push({ role: "tool", tool_call_id: tc.id, content: obs });
      // Track a run of engine-down-looking results (turtle_sim envError OR a run_js result
      // carrying an engine-fault signature). A healthy result resets the counter.
      s.stall = ENGINE_DOWN_RE.test(obs) ? s.stall + 1 : 0;
    }

    // Enough consecutive engine-down signals? CONFIRM with an authoritative smoke test —
    // if the engine really is down, abort NOW with a diagnosis rather than grinding to
    // maxSteps against a dead sandbox. (The third agent's `report` field can carry this
    // failure/details; here we fail the workflow with a distinct, legible cause.)
    if (patched("engine-guardrails-v1") && s.stall >= STALL_PROBE) {
      const eng = await checkEngine({ workSession });
      if (!eng.ok)
        throw ApplicationFailure.nonRetryable(
          `sim engine collapsed mid-run — ${s.stall} consecutive engine-fault tool results, confirmed down by smoke test: ${eng.detail}. ` +
          `Aborting at step ${s.step}/${maxSteps} (best score ${Math.max(s.best.score, 0)}/${s.best.total}) instead of burning the full budget on a dead sandbox.`,
          "SimEngineUnavailable");
      s.stall = 0; // false alarm (e.g. the agent's own throwing probe) — engine is fine, continue
    }

    // Completion runs SOLELY through the finish signal (mini-swe has_finished pattern): the
    // DETERMINISTIC validator is called ONLY when the agent takes no action this turn (it is
    // signalling done). turtle_sim and run_js are just the agent's work tools and never
    // terminate the loop themselves — so validation never fires mid-work. On the finish signal:
    // pass -> Submitted (done); fail -> inject the verdict and keep stepping (NonTerminating).
    if (a.toolCalls.length === 0) {
      try {
        const chk = await checkCompleted({ workSession, envs: input.envs });
        if (chk.score > s.best.score) s.best = { program: chk.program || s.best.program, score: chk.score, total: chk.total, passed: chk.complete };
        s.best.passed = s.best.passed || chk.complete;
        if (chk.complete) return done();
        s.lastObs = chk.feedback; // failing-invariant detail from the finish-signal validator
        s.messages.push({ role: "user", content: chk.feedback + " You are NOT finished — fix the program, test it with turtle_sim, and only stop once every invariant passes." });
      } catch { /* validator env error -> keep going */ }
    }

    s.step++;
    if (s.step % COMPACT_EVERY === 0) await continueAsNew<typeof researchWorkflow>(input, s);
  }

  // final gate: catch a passing program that was written (e.g. via run_js) but never tool-tested
  if (!s.best.passed) {
    try {
      const chk = await checkCompleted({ workSession, envs: input.envs });
      if (chk.score > s.best.score) s.best = { program: chk.program || s.best.program, score: chk.score, total: chk.total, passed: chk.complete };
    } catch { /* ignore */ }
  }
  return done();
}
