// The researcher as a Temporal-native agent loop (mini-swe-agent MCP edition shape).
// The WORKFLOW owns the loop and the message history — durable via event replay, so a
// dead worker resumes exactly. The model's tool_calls are dispatched as activities:
//   turtle_sim -> turtleSim (run the program against the arena, the state mutation)
//   run_js     -> runJs     (raw sandbox inspection)
// Terminates when turtle_sim passes, the model stops calling tools, or max steps.
import { proxyActivities, workflowInfo, continueAsNew } from "@temporalio/workflow";
import type * as acts from "./activities.ts";
import { TOOLS } from "./tools.ts";
import type { Env } from "./arena-object.ts";

const { openSandbox, turtleSim, checkCompleted, runJs } = proxyActivities<typeof acts>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 6, initialInterval: "2 seconds", maximumInterval: "30 seconds" },
});
// callLlm + summarize get a longer budget (glm can be slow on larger contexts) and fewer
// retries — a retry with the SAME context just times out again, so don't burn 6 attempts.
const { callLlm, summarize } = proxyActivities<typeof acts>({
  startToCloseTimeout: "6 minutes",
  retry: { maximumAttempts: 3, initialInterval: "3 seconds", maximumInterval: "20 seconds" },
});

export type ResearchInput = { task: string; envs: Env[]; systemPrompt: string; model?: string; maxSteps?: number };
export type ResearchResult = { passed: boolean; score: number; total: number; program: string; attempts: number };
type Best = { program: string; score: number; total: number; passed: boolean };
type LoopState = { messages: any[]; step: number; best: Best; attempts: number; opened: boolean; summary: string };

const COMPACT_EVERY = 30; // continue-as-new cadence, to bound Temporal event-history size

// ── Context compaction: threshold-triggered rolling summary + tool-pair-safe verbatim tail.
// Bind to glm-5.2's window (Ollama glm-5.2:cloud = 976K tokens) but run under a working cap for
// latency. The WHEN (estTokens) and WHICH (group-boundary tail walk) are pure -> replay-stable;
// only summarize() is non-deterministic (an activity; Temporal records its result).
const MODEL_WINDOW = 976000;                              // glm-5.2:cloud context window (Ollama) — re-read if the tag changes
const WORKING_CAP = Math.min(160000, MODEL_WINDOW);      // practical latency/cost budget, ~16% of the window
const COMPACT_THRESHOLD = Math.floor(0.70 * WORKING_CAP); // 112000 — compact when the sent view reaches this
const COMPACT_TARGET = Math.floor(0.50 * WORKING_CAP);    // 80000 — fold/evict down to this
const TAIL_TOKEN_BUDGET = 40000;                          // keep this many recent est-tokens verbatim
const MIN_TAIL_GROUPS = 3;                                // ...but always keep at least this many recent turn-groups
const TOOLS_SCHEMA_TOK = Math.ceil(JSON.stringify(TOOLS).length / 4); // static tool-schema token cost

// deterministic ~4-chars/token estimate (+8 per-message role/framing overhead)
function estMsg(m: any): number {
  const s = String(m.content ?? "").length
    + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)
    + (m.tool_call_id ? String(m.tool_call_id).length : 0);
  return Math.ceil(s / 4) + 8;
}
function estTokens(view: any[]): number {
  let t = TOOLS_SCHEMA_TOK;
  for (const m of view) t += estMsg(m);
  return t;
}
// what we actually send: pinned system + first user, then the rolling summary block, then live turns
function sendView(s: LoopState): any[] {
  const head: any[] = [s.messages[0], s.messages[1]];
  if (s.summary) head.push({ role: "system", content: "CONVERSATION SUMMARY (compacted history; authoritative record of everything before the recent turns):\n" + s.summary });
  return head.concat(s.messages.slice(2));
}
// pure turn-group boundaries over msgs[start..]: an assistant(tool_calls) + its following tool
// messages is one atomic group; any other message is its own group. Cuts land only on boundaries.
function groupsFrom(msgs: any[], start: number): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  let i = start;
  while (i < msgs.length) {
    let j = i + 1;
    if (msgs[i].role === "assistant" && msgs[i].tool_calls) while (j < msgs.length && msgs[j].role === "tool") j++;
    groups.push({ start: i, end: j });
    i = j;
  }
  return groups;
}
// called BEFORE every callLlm. Deterministic except the summarize ACTIVITY.
async function compactIfNeeded(s: LoopState): Promise<void> {
  if (estTokens(sendView(s)) < COMPACT_THRESHOLD) return;
  const groups = groupsFrom(s.messages, 2);
  if (groups.length === 0) return;
  // 1) pick the verbatim tail by walking whole groups backward (pure)
  let acc = 0, kept = 0, tailStart = s.messages.length;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    let gTok = 0; for (let k = g.start; k < g.end; k++) gTok += estMsg(s.messages[k]);
    if (kept >= MIN_TAIL_GROUPS && acc + gTok > TAIL_TOKEN_BUDGET) break;
    acc += gTok; kept++; tailStart = g.start;
  }
  // 2) fold the evicted middle into the rolling summary (the LLM activity)
  const evicted = s.messages.slice(2, tailStart);
  if (evicted.length > 0) {
    s.summary = (await summarize({ oldSummary: s.summary, evicted, task: String(s.messages[1].content) })).summary;
    s.messages = [s.messages[0], s.messages[1], ...s.messages.slice(tailStart)];
  }
  // 3) if the tail alone still exceeds target, fold its oldest groups one at a time (keep a min tail)
  while (estTokens(sendView(s)) > COMPACT_TARGET) {
    const g = groupsFrom(s.messages, 2);
    if (g.length <= MIN_TAIL_GROUPS) break;
    const chunk = s.messages.slice(2, g[0].end);
    s.summary = (await summarize({ oldSummary: s.summary, evicted: chunk, task: String(s.messages[1].content) })).summary;
    s.messages = [s.messages[0], s.messages[1], ...s.messages.slice(g[0].end)];
  }
}

export async function researchWorkflow(input: ResearchInput, state?: LoopState): Promise<ResearchResult> {
  const model = input.model || "glm-5.2";
  const maxSteps = input.maxSteps ?? 60;
  const workSession = workflowInfo().workflowId; // stable across continue-as-new -> same /work

  let s: LoopState = state ?? {
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: `${input.task}\n\nBegin. Write the program and call turtle_sim to test it; read the failing invariants and iterate until it reports 0 failed.` },
    ],
    step: 0, best: { program: "", score: -1, total: 0, passed: false }, attempts: 0, opened: false, summary: "",
  };

  if (!s.opened) { await openSandbox(workSession); s.opened = true; }

  const done = async (): Promise<ResearchResult> => {
    // if we passed via a file the agent wrote directly (no turtle_sim), fetch the program
    if (s.best.passed && !s.best.program) {
      const p = await runJs({ workSession, code: `console.log(await fs.readFile('/work/prog.lua','utf8').catch(()=>''))` });
      s.best.program = p.text.trim();
    }
    return { passed: s.best.passed, score: Math.max(s.best.score, 0), total: s.best.total, program: s.best.program, attempts: s.attempts };
  };

  while (s.step < maxSteps) {
    await compactIfNeeded(s); // bind to glm-5.2's window via rolling-summary compaction

    // A retry-exhausted activity must NOT hard-FAIL the whole research: end gracefully and
    // return the best attempt (research_status then reports type:error with prog.lua metadata).
    let a: acts.LlmOut;
    try {
      a = await callLlm({ messages: sendView(s), tools: TOOLS, model });
    } catch { break; } // e.g. glm timeout after retries -> stop, return best-so-far

    s.messages.push(a.toolCalls.length
      ? { role: "assistant", content: a.content, tool_calls: a.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) }
      : { role: "assistant", content: a.content });

    // dispatch each tool_call as an activity (mutation with tools)
    let ranValidatorFresh = false;
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
          ranValidatorFresh = true; // turtle_sim ran the deterministic validator on /work/prog.lua this turn
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

    // validator-in-the-loop (check_completed): the DETERMINISTIC gate. Run it whenever we
    // don't already have a fresh validator result from turtle_sim this turn (e.g. the model
    // used only run_js, or declared done with no tool call). Its output is injected into
    // history and the loop breaks ONLY on a real PASS — the agent cannot self-declare done.
    if (!ranValidatorFresh) {
      try {
        const chk = await checkCompleted({ workSession, envs: input.envs });
        if (chk.score > s.best.score) s.best = { program: chk.program || s.best.program, score: chk.score, total: chk.total, passed: chk.complete };
        s.best.passed = s.best.passed || chk.complete;
        s.messages.push({ role: "user", content: chk.feedback });
        if (chk.complete) return done();
      } catch { /* validator env error -> skip this turn's gate, keep going */ }
    } else if (s.best.passed) {
      return done();
    }

    s.step++;
    if (s.step % COMPACT_EVERY === 0) await continueAsNew<typeof researchWorkflow>(input, s);
  }
  return done();
}
