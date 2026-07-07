// The researcher as a Temporal-native agent loop (mini-swe-agent MCP edition shape).
// The WORKFLOW owns the loop and the message history — durable via event replay, so a
// dead worker resumes exactly. The model's tool_calls are dispatched as activities:
//   turtle_sim -> turtleSim (run the program against the arena, the state mutation)
//   run_js     -> runJs     (raw sandbox inspection)
// Terminates when turtle_sim passes, the model stops calling tools, or max steps.
import { proxyActivities, workflowInfo, continueAsNew } from "@temporalio/workflow";
import type * as acts from "./activities.ts";
import { TOOLS } from "./tools.ts";
import { estTokens, sendView, COMPACT_THRESHOLD, toolsSchemaTok } from "./compaction.ts";
import type { Env } from "./arena-object.ts";

const { openSandbox, turtleSim, checkCompleted, runJs } = proxyActivities<typeof acts>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 6, initialInterval: "2 seconds", maximumInterval: "30 seconds" },
});
// callLlm + compact use fewer retries — a retry with the SAME context just times out again, so
// don't burn 6 attempts.
// callLlm + compact hit Ollama, which fails intermittently ("fetch failed"). Temporal
// retries the ACTIVITY in place (the workflow keeps its state and resumes — it does NOT
// restart), so we retry generously to ride out a provider blip: up to 30 attempts,
// backing off to one per minute (~30 min of coverage). A network/5xx/429 error is
// retried; a 4xx client error (bad key/request) is thrown non-retryable and fails fast.
const { callLlm, compact } = proxyActivities<typeof acts>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 30, initialInterval: "2 seconds", backoffCoefficient: 2, maximumInterval: "60 seconds" },
});

const TOOLS_SCHEMA_TOK = toolsSchemaTok(TOOLS); // static tool-schema token cost, for the gate

export type ResearchInput = { task: string; envs: Env[]; systemPrompt: string; model?: string; maxSteps?: number; maxTokens?: number };
export type ResearchResult = { passed: boolean; score: number; total: number; program: string; attempts: number; steps: number; tokens: number; report: string };
type Best = { program: string; score: number; total: number; passed: boolean };
type LoopState = { messages: any[]; step: number; best: Best; attempts: number; opened: boolean; summary: string; tokens: number; lastObs: string };

const COMPACT_EVERY = 30; // continue-as-new cadence, to bound Temporal event-history size

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
  else if (!solved) parts.push(`No compaction record was produced (short run). See the most recent validator result above.`);
  return parts.join("\n\n");
}

// cheap, deterministic gate (workflow-side, no transcript serialization); the actual eviction +
// summarization is the compact ACTIVITY, invoked only when this trips.
function needsCompaction(s: LoopState): boolean {
  return estTokens(sendView(s.messages, s.summary), TOOLS_SCHEMA_TOK) >= COMPACT_THRESHOLD;
}

export async function researchWorkflow(input: ResearchInput, state?: LoopState): Promise<ResearchResult> {
  const model = input.model || "glm-5.2";
  const maxSteps = input.maxSteps ?? 120;
  const workSession = workflowInfo().workflowId; // stable across continue-as-new -> same /work

  let s: LoopState = state ?? {
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: `${input.task}\n\nBegin. Write the program and call turtle_sim to test it; read the failing invariants and iterate until it reports 0 failed.` },
    ],
    step: 0, best: { program: "", score: -1, total: 0, passed: false }, attempts: 0, opened: false, summary: "", tokens: 0, lastObs: "",
  };
  const maxTokens = input.maxTokens ?? 0; // 0 = unbounded

  if (!s.opened) { await openSandbox(workSession); s.opened = true; }

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
    if (needsCompaction(s)) {
      const r = await compact({ messages: s.messages, summary: s.summary, task: String(s.messages[1].content), toolsSchemaTok: TOOLS_SCHEMA_TOK });
      s.messages = r.messages; s.summary = r.summary; s.tokens += r.tokens;
    }

    // callLlm failing after its retries means the LLM is unreachable (e.g. a network
    // "fetch failed" to Ollama) — a real infra failure, NOT a "did not pass" result. Let it
    // propagate so the workflow reports FAILED, instead of masking it as an empty best attempt.
    // (Budget/step exhaustion is the legitimate graceful path — see the while-condition + done().)
    const a: acts.LlmOut = await callLlm({ messages: sendView(s.messages, s.summary), tools: TOOLS, model, step: s.step });
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
          const r = await turtleSim({ workSession, program, envs: input.envs });
          obs = r.observation;
          s.lastObs = r.observation; // most recent sim/validator feedback -> caller-facing report
          if (r.score > s.best.score) s.best = { program, score: r.score, total: r.total, passed: r.passed };
        } else if (tc.name === "run_js") {
          obs = (await runJs({ workSession, code: String(args.code ?? "") })).text || "(no output)";
        } else {
          obs = `unknown tool: ${tc.name}`;
        }
      } catch (e) {
        obs = `tool ${tc.name} failed (transient environment error): ${String(e).slice(0, 200)}. Try again.`;
      }
      s.messages.push({ role: "tool", tool_call_id: tc.id, content: obs });
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
