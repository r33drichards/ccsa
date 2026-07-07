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
// callLlm gets a longer budget (glm can be slow on larger contexts) and fewer retries —
// a retry with the SAME context just times out again, so don't burn 6 attempts on it.
const { callLlm } = proxyActivities<typeof acts>({
  startToCloseTimeout: "6 minutes",
  retry: { maximumAttempts: 3, initialInterval: "3 seconds", maximumInterval: "20 seconds" },
});

export type ResearchInput = { task: string; envs: Env[]; systemPrompt: string; model?: string; maxSteps?: number };
export type ResearchResult = { passed: boolean; score: number; total: number; program: string; attempts: number };
type Best = { program: string; score: number; total: number; passed: boolean };
type LoopState = { messages: any[]; step: number; best: Best; attempts: number; opened: boolean };

const COMPACT_EVERY = 30; // continue-as-new cadence, to bound workflow history size
const KEEP_TAIL = 14;     // recent messages kept (plus system + first user) to bound LLM context

// Keep the system prompt (arena + skills) + the first user message + the last KEEP_TAIL
// messages. Advancing past a leading `role:"tool"` avoids orphaning a tool result from its
// assistant tool_calls (which the chat API rejects). This is what keeps callLlm fast — an
// unbounded transcript is what made it exceed its timeout and fail the workflow.
function pruneMessages(msgs: any[]): any[] {
  if (msgs.length <= KEEP_TAIL + 3) return msgs;
  let start = msgs.length - KEEP_TAIL;
  while (start < msgs.length && msgs[start].role === "tool") start++;
  return [msgs[0], msgs[1],
    { role: "user", content: "[earlier turns elided to bound context; the arena, invariants, and skills remain in the system message above]" },
    ...msgs.slice(start)];
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
    step: 0, best: { program: "", score: -1, total: 0, passed: false }, attempts: 0, opened: false,
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
    s.messages = pruneMessages(s.messages); // bound the LLM context so callLlm stays fast

    // A retry-exhausted activity must NOT hard-FAIL the whole research: end gracefully and
    // return the best attempt (research_status then reports type:error with prog.lua metadata).
    let a: acts.LlmOut;
    try {
      a = await callLlm({ messages: s.messages, tools: TOOLS, model });
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
