// Craftos sim harness for the languages sandbox: build the run_js validator that
// runs the agent's Lua against every arena environment, parse the ok/FAIL log, and
// assemble the researcher's system prompt (skills inlined). Ported from craftgen.py.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { envToWorldLua, envLabel, envTurtles, type Env } from "./arena-object.ts";
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
  // Naive data pipe: each env becomes a set of multi-node craftos computers — the
  // turtle node (runs the agent's /work/prog.lua) plus any caller-defined helper
  // nodes (e.g. gps hosts). Only turtle nodes get prog.lua; nilSim turtle nodes run
  // it with `sim` shadowed to exercise the real-device path.
  const nodes: any[] = [];
  const worlds: Record<string, string> = {};
  envs.forEach((e, i) => {
    const label = envLabel(e, i);
    const worldName = `${label}_shared`;
    worlds[worldName] = envToWorldLua(e);
    const turtles = envTurtles(e);
    const networked = turtles.length > 1 || !!(e.nodes && e.nodes.length);
    turtles.forEach((t, j) => {
      const start = { x: 8, y: 64, z: 8, ...(j === 0 ? e.start || {} : {}), ...(t.start || {}) } as { x: number; y: number; z: number };
      nodes.push({
        label: t.label || (j === 0 ? label : `${label}_t${j + 1}`),
        collect: j === 0, test: j === 0, position: [start.x, start.y, start.z], world: worldName, start,
        __turtle: true, __nilSim: j === 0 && !!e.nilSim, __net: networked,
        __program: t.program, __primary: j === 0,
      });
    });
    (e.nodes || []).forEach((n, j) => {
      const hn: any = { label: n.label || `${label}_n${j}`, program: n.program };
      if (n.position) hn.position = n.position;
      if (n.world) { hn.world = n.world === "shared" ? worldName : n.world; hn.start = n.start; }
      nodes.push(hn);
    });
  });
  return (
    `(0,eval)(await fs.readFile(${JSON.stringify(WORK_BOOTSTRAP)},'utf8'));\n` +
    `let __prog; try { __prog = await fs.readFile(${JSON.stringify(progPath)},'utf8'); } catch (e) { __prog = undefined; }\n` +
    `if (__prog === undefined || __prog === '') { console.log(JSON.stringify({ status:'missing' })); }\n` +
    `else { const nodes = ${JSON.stringify(nodes)}; const worlds = ${JSON.stringify(worlds)};\n` +
    // Networked turtle: the arena equips a wireless modem and gives the gps hosts a
    // beat to start listening before the program pings (transparent env plumbing).
    `  for (const n of nodes) { if (n.__turtle) { let __pre = n.__net ? "periphemu.create('top','modem',NET,true)\\nsleep(1)\\n" : ''; if (n.__nilSim) __pre += 'local sim = nil\\n'; n.program = __pre + (n.__program ?? __prog); delete n.__turtle; delete n.__nilSim; delete n.__net; delete n.__program; delete n.__primary; } }\n` +
    `  const out = await craftos({ nodes, worlds });\n` +
    `  console.log(JSON.stringify({ nodes: out.nodes.map(n => ({ label: n.label, output: n.output })) })); }\n`
  );
}

// envError === the SIM ENGINE ITSELF failed to load/run (not the agent's Lua). The
// validator run_js emits a parseable `{nodes:[...]}` verdict only when the craftos
// engine actually loaded and ran the program. If instead the raw text carries one of
// these signatures, the loader threw BEFORE any invariant could be evaluated — i.e.
// /work/bootstrap.js is gone (ENOENT), the whole /work snapshot vanished, `craftos`
// is undefined, a path was denied by policy, or run_js died opaquely ([execution
// failed]). Collapsing that into "your program errored (0/0)" is exactly what sent
// turtle-inher87j chasing a phantom Lua bug for 1.9M tokens — so we surface it as a
// distinct ENVIRONMENT fault instead. A real Lua error still produces a nodes verdict
// (the engine catches it per-node), so this only fires when the engine never ran.
const ENGINE_DOWN = /\[execution failed\]|(?:craftos|picat)\s+is\s+not\s+defined|ENOENT|denied by policy/;

export type SimResult = { score: number; total: number; passed: boolean; failures: string[]; output: string; envError: boolean };

export function parseSim(text: string): SimResult {
  const lines = text.trim().split("\n");
  let verdict: any;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && Array.isArray(o.nodes)) { verdict = o; break; } } catch { /* keep scanning */ }
  }
  if (!verdict) return { score: 0, total: 0, passed: false, failures: [], output: text.slice(0, 2000), envError: ENGINE_DOWN.test(text) };
  const combined = verdict.nodes.map((n: any) => `[${n.label}]\n${n.output ?? ""}`).join("\n");
  const score = (combined.match(/^\s*ok\s+-/gm) || []).length;
  const failures = (combined.match(/^\s*FAIL\s+-.*$/gm) || []).map((s: string) => s.trim());
  const total = score + failures.length;
  const passed = total > 0 && combined.includes("SIM_RESULT: PASS") && !combined.includes("SIM_RESULT: FAIL");
  return { score, total, passed, failures, output: combined, envError: false };
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
      "- turtle_sim(program) — how you TEST and SUBMIT your program, and the ONLY authority on completion. It " +
      "writes /work/prog.lua, runs it against EVERY arena environment, and returns the per-invariant ok/FAIL " +
      "log; you are done only when it reports 0 failed. Submit real attempts and iterate from the failures it " +
      "reports — declaring done without a passing turtle_sim does nothing.\n" +
      "- run_js(code) — inspect and experiment in the sandbox as much as is useful: read the skills under " +
      `${WORK_SKILLS}, run the craftos engine yourself on a draft, print engine internals, etc. A fresh V8 ` +
      "isolate each call; /work persists.\n" +
      "  ⚠ In run_js, `fs`, `craftos`, `picat` are READY-MADE GLOBALS — use them directly (await fs.readFile(" +
      "path,'utf8'), await craftos({...})). NO module system: require('fs') and import are DISABLED and throw. " +
      `To run the engine yourself: (0,eval)(await fs.readFile(${JSON.stringify(WORK_BOOTSTRAP)},'utf8')); const ` +
      "out = await craftos({ worlds:{w:'return {...}'}, nodes:[{ label:'c1', collect:true, world:'w', start:{...}, program:'...' }] }); " +
      "console.log(JSON.stringify(out)).\n",
    "\n=== YOUR JOB ===\n" +
      `TASK: ${task}\n\n` +
      "Write a CC:Tweaked Lua turtle program that makes every invariant below pass. Explore the engine and " +
      "skills with run_js as much as helps — but converge: submit real attempts with turtle_sim and iterate on " +
      "the failing invariants until it reports 0 failed.\n" +
      "FINISH PROTOCOL: when turtle_sim reports 0 failed, you are passing — reply with a brief confirmation and " +
      "NO tool call. That is your 'done' signal; a final deterministic validation then submits your program. If " +
      "that validation still finds a failing invariant, you will be told and must keep fixing. Do not stop while " +
      "any invariant is failing.\n\n" +
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
