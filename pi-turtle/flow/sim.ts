// Craftos sim harness for the languages sandbox: build the run_js validator that
// runs the agent's Lua against every arena environment, parse the ok/FAIL log, and
// assemble the researcher's system prompt (skills inlined). Ported from craftgen.py.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { envToWorldLua, envLabel, type Env } from "./arena-object.ts";
import { WORK_BOOTSTRAP, WORK_SKILLS } from "./mcp-languages.ts";

const REPO = join(import.meta.dirname, "..", "..");
const SKILLS_DIR = join(REPO, "languages", "skills");
const BOOTSTRAP = join(REPO, "languages", "bootstrap.js");

// ── skills ────────────────────────────────────────────────────────────────
export function readSkill(name: string): string {
  const p = join(SKILLS_DIR, name, "SKILL.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
// pick the task-specific abstract skill from the arena text alone (examples, not dogma)
export function focusSkillsFor(arenaText: string): string[] {
  const base = ["craftos-sim", "cc-tweaked"];
  if (/recipes|craft/i.test(arenaText)) return [...base, "turtle-crafter-compressor"];
  if (/sorted|consolidat/i.test(arenaText)) return [...base, "turtle-sorter"];
  return base;
}
// every skill file, for seeding the sandbox /work/skills so the agent can read full ctx itself
export function skillSeedFiles(): Record<string, string> {
  const out: Record<string, string> = { [WORK_BOOTSTRAP]: readFileSync(BOOTSTRAP, "utf8") };
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[`${WORK_SKILLS}/${relative(SKILLS_DIR, p).split("\\").join("/")}`] = readFileSync(p, "utf8");
    }
  };
  walk(SKILLS_DIR);
  return out;
}

// ── validator (the deterministic check_completed) ────────────────────────────
export const WORK_PROG = "/work/prog.lua";
// run_js source: load the engine, read the agent's program off /work/prog.lua (the
// single source of truth — the agent writes it via turtle_sim), run it against every
// env, print each node's output as JSON. The engine's test(sim) emits `ok -`/`FAIL -`
// lines and a `SIM_RESULT: PASS|FAIL` per node. Prints {status:'missing'} if no program.
export function validatorFromWorkCode(envs: Env[], progPath = WORK_PROG): string {
  const nodes = envs.map((e, i) => ({ label: envLabel(e, i), collect: true, world_lua: envToWorldLua(e) }));
  return (
    `(0,eval)(await fs.readFile(${JSON.stringify(WORK_BOOTSTRAP)},'utf8'));\n` +
    `let __prog; try { __prog = await fs.readFile(${JSON.stringify(progPath)},'utf8'); } catch (e) { __prog = undefined; }\n` +
    `if (__prog === undefined || __prog === '') { console.log(JSON.stringify({ status:'missing' })); }\n` +
    `else { const nodes = ${JSON.stringify(nodes)}; for (const n of nodes) n.program = __prog;\n` +
    `  const out = await craftos({ nodes });\n` +
    `  console.log(JSON.stringify({ nodes: out.nodes.map(n => ({ label: n.label, output: n.output })) })); }\n`
  );
}

export type SimResult = { score: number; total: number; passed: boolean; failures: string[]; output: string };

export function parseSim(text: string): SimResult {
  const lines = text.trim().split("\n");
  let verdict: any;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && Array.isArray(o.nodes)) { verdict = o; break; } } catch { /* keep scanning */ }
  }
  if (!verdict) return { score: 0, total: 0, passed: false, failures: [], output: text.slice(0, 2000) };
  const combined = verdict.nodes.map((n: any) => `[${n.label}]\n${n.output ?? ""}`).join("\n");
  const score = (combined.match(/^\s*ok\s+-/gm) || []).length;
  const failures = (combined.match(/^\s*FAIL\s+-.*$/gm) || []).map((s: string) => s.trim());
  const total = score + failures.length;
  const passed = total > 0 && combined.includes("SIM_RESULT: PASS") && !combined.includes("SIM_RESULT: FAIL");
  return { score, total, passed, failures, output: combined };
}

// ── system prompt ─────────────────────────────────────────────────────────
const SYSTEM =
  "You are an autonomous agent that writes a CC:Tweaked (ComputerCraft) Lua TURTLE PROGRAM and gets it " +
  "passing a deterministic simulation. Take ONE action at a time via the provided tools and observe the " +
  "result before the next. When every invariant passes, reply with a final message and NO tool call.";

export function buildSystemPrompt(task: string, envs: Env[], arenaYaml: string): string {
  const focus = focusSkillsFor(task + "\n" + arenaYaml).map((n) => ({ name: n, text: readSkill(n) })).filter((s) => s.text);
  const parts = [
    SYSTEM,
    "\n\n=== TOOLS ===\n" +
      "- turtle_sim(program): run your COMPLETE Lua turtle program against EVERY arena environment and get " +
      "back the per-invariant ok/FAIL log. This is the authority: you are done ONLY when it reports all pass " +
      "(0 failed). Submit the whole program each call; iterate on the failures.\n" +
      "- run_js(code): evaluate JavaScript in the languages sandbox to inspect state or run the craftos engine " +
      "yourself. A FRESH V8 isolate each call, but /work PERSISTS and is fully isolated (no host disk). It has " +
      "the craftos engine and the full skills tree. run_js returns ONLY what you console.log(...). Load the " +
      `engine and call it in the SAME block, e.g.:\n  (0,eval)(await fs.readFile(${JSON.stringify(WORK_BOOTSTRAP)},'utf8'));\n` +
      "  const out = await craftos({ nodes:[{ label:'c1', collect:true, world_lua:'...', program:'...' }] });\n" +
      "  console.log(JSON.stringify(out));\n" +
      `The bootstrap is ${WORK_BOOTSTRAP}; the full SKILL.md tree is under ${WORK_SKILLS} — read any of it on ` +
      `demand with run_js: console.log(await fs.readFile(${JSON.stringify(WORK_SKILLS + "/cc-tweaked/SKILL.md")}, 'utf8')).\n`,
    "\n=== YOUR JOB ===\n" +
      `TASK: ${task}\n\n` +
      "Write a single CC:Tweaked Lua turtle program that makes every invariant below pass. Iterate with " +
      "turtle_sim until it reports 0 failed. Declaring success without a passing turtle_sim does nothing.\n\n" +
      "FAIL OPEN ON A NIL `sim` (the program must run on a REAL turtle too): the `sim` global (sim.pos, " +
      "sim.chest, sim.assert*, setpos, ...) exists ONLY in this simulator; on a real device it is nil and any " +
      "unguarded `sim.xxx()` throws. Never touch `sim.*` unguarded — get real inputs from gps/inspect/" +
      "peripherals/constants and treat `sim` as an optional convenience.\n\n" +
      "THE ARENA (each environment's world + `test(sim)` post-condition; your program runs against ALL of " +
      "them):\n```yaml\n" + arenaYaml + "```\n",
  ];
  if (focus.length) {
    parts.push(
      `\n=== REFERENCE SKILLS (principles, not the answer) ===\nFull SKILL.md for ${focus.map((s) => s.name).join(", ")} ` +
      `below; the rest of the tree is fs-readable under ${WORK_SKILLS}.\n`);
    for (const s of focus) parts.push(`\n----- SKILL: ${s.name} -----\n${s.text.trim()}\n`);
  }
  return parts.join("");
}
