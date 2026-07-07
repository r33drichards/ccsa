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
const { callLlm, compact } = proxyActivities<typeof acts>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 3, initialInterval: "3 seconds", maximumInterval: "20 seconds" },
});

const TOOLS_SCHEMA_TOK = toolsSchemaTok(TOOLS); // static tool-schema token cost, for the gate

export type ResearchInput = { task: string; envs: Env[]; systemPrompt: string; model?: string; maxSteps?: number; maxTokens?: number };
export type ResearchResult = { passed: boolean; score: number; total: number; program: string; attempts: number; steps: number; tokens: number };
type Best = { program: string; score: number; total: number; passed: boolean };
type LoopState = { messages: any[]; step: number; best: Best; attempts: number; opened: boolean; summary: string; tokens: number };

const COMPACT_EVERY = 30; // continue-as-new cadence, to bound Temporal event-history size

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
    step: 0, best: { program: "", score: -1, total: 0, passed: false }, attempts: 0, opened: false, summary: "", tokens: 0,
  };
  const maxTokens = input.maxTokens ?? 0; // 0 = unbounded

  if (!s.opened) { await openSandbox(workSession); s.opened = true; }

  const done = async (): Promise<ResearchResult> => {
    // if we passed via a file the agent wrote directly (no turtle_sim), fetch the program
    if (s.best.passed && !s.best.program) {
      const p = await runJs({ workSession, code: `console.log(await fs.readFile('/work/prog.lua','utf8').catch(()=>''))` });
      s.best.program = p.text.trim();
    }
    return { passed: s.best.passed, score: Math.max(s.best.score, 0), total: s.best.total, program: s.best.program, attempts: s.attempts, steps: s.step, tokens: s.tokens };
  };

  while (s.step < maxSteps) {
    if (maxTokens && s.tokens >= maxTokens) break; // token budget exhausted -> return best-so-far

    // bind to glm-5.2's window: cheap gate here, the eviction + summarization is the compact activity
    if (needsCompaction(s)) {
      const r = await compact({ messages: s.messages, summary: s.summary, task: String(s.messages[1].content), toolsSchemaTok: TOOLS_SCHEMA_TOK });
      s.messages = r.messages; s.summary = r.summary; s.tokens += r.tokens;
    }

    // A retry-exhausted activity must NOT hard-FAIL the whole research: end gracefully and
    // return the best attempt (research_status then reports type:error with prog.lua metadata).
    let a: acts.LlmOut;
    try {
      a = await callLlm({ messages: sendView(s.messages, s.summary), tools: TOOLS, model });
    } catch { break; } // e.g. glm timeout after retries -> stop, return best-so-far
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
