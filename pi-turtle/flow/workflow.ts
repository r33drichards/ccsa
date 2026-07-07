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

const { openSandbox, callLlm, turtleSim, checkCompleted, runJs } = proxyActivities<typeof acts>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 6, initialInterval: "2 seconds", maximumInterval: "30 seconds" },
});

export type ResearchInput = { task: string; envs: Env[]; systemPrompt: string; model?: string; maxSteps?: number };
export type ResearchResult = { passed: boolean; score: number; total: number; program: string; attempts: number };
type Best = { program: string; score: number; total: number; passed: boolean };
type LoopState = { messages: any[]; step: number; best: Best; attempts: number; opened: boolean };

const COMPACT_EVERY = 30; // continue-as-new cadence, to bound workflow history size

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
    const a = await callLlm({ messages: s.messages, tools: TOOLS, model });
    s.messages.push(a.toolCalls.length
      ? { role: "assistant", content: a.content, tool_calls: a.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) }
      : { role: "assistant", content: a.content });

    // dispatch each tool_call as an activity (mutation with tools)
    let ranValidatorFresh = false;
    for (const tc of a.toolCalls) {
      let args: any = {};
      try { args = JSON.parse(tc.arguments || "{}"); } catch { /* malformed -> empty */ }
      let obs: string;
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
      s.messages.push({ role: "tool", tool_call_id: tc.id, content: obs });
    }

    // validator-in-the-loop (check_completed): the DETERMINISTIC gate. Run it whenever we
    // don't already have a fresh validator result from turtle_sim this turn (e.g. the model
    // used only run_js, or declared done with no tool call). Its output is injected into
    // history and the loop breaks ONLY on a real PASS — the agent cannot self-declare done.
    if (!ranValidatorFresh) {
      const chk = await checkCompleted({ workSession, envs: input.envs });
      if (chk.score > s.best.score) s.best = { program: s.best.program, score: chk.score, total: chk.total, passed: chk.complete };
      s.best.passed = s.best.passed || chk.complete;
      s.messages.push({ role: "user", content: chk.feedback });
      if (chk.complete) return done();
    } else if (s.best.passed) {
      return done();
    }

    s.step++;
    if (s.step % COMPACT_EVERY === 0) await continueAsNew<typeof researchWorkflow>(input, s);
  }
  return done();
}
