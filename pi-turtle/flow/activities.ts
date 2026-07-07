// Temporal activities for the Temporal-native researcher (pi removed). The WORKFLOW
// owns the agentic loop + message history (durable via event replay); these activities
// are the non-deterministic I/O it dispatches:
//   openSandbox  - open the mcp-js languages session + seed engine/skills into /work
//   callLlm      - one glm completion (Ollama OpenAI-compatible API) with the tools
//   turtleSim    - run the submitted Lua against the arena via mcp-js (the state mutation)
//   runJs        - raw run_js passthrough, so the agent can inspect the sandbox itself
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as lang from "./mcp-languages.ts";
import { validatorFromWorkCode, parseSim, skillSeedFiles, WORK_PROG, type SimResult } from "./sim.ts";
import type { Env } from "./arena-object.ts";

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

export type LlmOut = { content: string; toolCalls: { id: string; name: string; arguments: string }[] };

// One completion. Env access is allowed in activities; Temporal owns retries.
export async function callLlm(input: { messages: unknown[]; tools: unknown[]; model: string }): Promise<LlmOut> {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) throw new Error("OLLAMA_API_KEY not set");
  const model = process.env.TURTLEFLOW_MODEL || input.model || "glm-5.2";
  const r = await fetch(`${OLLAMA_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: input.messages, tools: input.tools, tool_choice: "auto", temperature: 0 }),
    signal: AbortSignal.timeout(300000), // 5 min, within the 6-min activity budget; context is pruned to keep this fast
  });
  if (!r.ok) throw new Error(`llm ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j: any = await r.json();
  const m = j.choices?.[0]?.message ?? {};
  return {
    content: m.content ?? "",
    toolCalls: (m.tool_calls ?? []).map((tc: any) => ({ id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" })),
  };
}

export type SimObs = SimResult & { observation: string };

function observe(res: SimResult): string {
  const head = res.total > 0 ? `score: ${res.score}/${res.total}${res.passed ? "  ✅ ALL PASS (0 failed)" : ""}` : "score: 0 (program errored at runtime — see log)";
  const fails = res.failures.length ? "\nfailing invariants:\n" + res.failures.map((f) => "  " + f).join("\n") : "";
  const log = res.total === 0 && res.output ? "\n" + res.output.slice(0, 1500) : "";
  return head + fails + log;
}

// turtle_sim: the state MUTATION — write the program to /work/prog.lua (single source
// of truth), then run it against every env. Returns the sim result as the agent's
// self-test observation.
export async function turtleSim(input: { workSession: string; program: string; envs: Env[] }): Promise<SimObs> {
  const c = await conn(input.workSession);
  await lang.runJs(c, `await fs.writeFile(${JSON.stringify(WORK_PROG)}, ${JSON.stringify(input.program)}); console.log('wrote ' + ${JSON.stringify(input.program.length)} + ' bytes');`);
  const res = parseSim(await lang.runJs(c, validatorFromWorkCode(input.envs)));
  return { ...res, observation: observe(res) };
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
  const feedback = res.passed
    ? `VALIDATOR: SIM_RESULT: PASS — all ${res.total} invariants met. Task complete.`
    : `VALIDATOR (deterministic; ran your /work/prog.lua against every environment): ${res.score}/${res.total} invariants passed.` +
      (res.failures.length ? "\n" + res.failures.map((f) => "  " + f).join("\n") : "") +
      (res.total === 0 ? "\n(program errored at runtime)\n" + res.output.slice(0, 1200) : "") +
      "\nYou are NOT done until 0 failed. Revise the program and resubmit it via turtle_sim.";
  return { complete: res.passed, feedback, score: res.score, total: res.total, program };
}

// run_js: raw sandbox passthrough for the agent's own inspection.
export async function runJs(input: { workSession: string; code: string }): Promise<{ text: string }> {
  const c = await conn(input.workSession);
  return { text: (await lang.runJs(c, input.code)).slice(0, 8000) };
}
