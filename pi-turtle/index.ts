// pi-turtle — a Pi package for making CC:Tweaked turtle programs.
//
// Three tools drive the whole flow against the self-hosted craftos sim:
//   create_sim   — turn a plain description (input item, output item, ratio) into
//                  a valid spec.yaml (chests + recipe + auto-derived checks).
//   turtle_sim   — run a submitted Lua program against the sim; return the score
//                  (# postconditions passed) + failing assertions. Iterate to max.
//   publish_gist — upload the passing program + spec to a GitHub gist via gh.
//
// High-level tools so a small model can drive the loop reliably (no bash, no
// hand-written run_js). The sim generation is deterministic (our code emits the
// Lua), so the TEST is always valid — only the turtle program is iterated.
//
// Env:
//   TURTLE_SIM_DIR  dir holding spec.yaml + bin/run_sim.py (default: <cwd>/spike/melon-loop)
//   TURTLE_PORT     languages server port (default: 8790)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SIM_DIR = process.env.TURTLE_SIM_DIR || join(process.cwd(), "spike/melon-loop");
const PORT = process.env.TURTLE_PORT || "8790";

interface SimResult { score: number; total: number; failures: string[]; raw: string; }

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: String(e) }));
  });
}

function runSim(): Promise<SimResult> {
  return new Promise((resolve) => {
    const child = spawn("uv", ["run", "bin/run_sim.py", "--port", PORT, "--spec", "spec.yaml"], {
      cwd: SIM_DIR,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", () => {
      const m = stderr.match(/passed=(\d+)\s+failed=(\d+)/);
      const score = m ? parseInt(m[1], 10) : parseInt(stdout.trim().split("\n").pop() || "0", 10) || 0;
      const total = m ? parseInt(m[1], 10) + parseInt(m[2], 10) : score;
      const failures = (stderr.match(/^\s*FAIL\s+-.*$/gm) || []).map((s) => s.trim());
      resolve({ score, total, failures, raw: (stderr + "\n" + stdout).trim() });
    });
    child.on("error", (e) => resolve({ score: 0, total: 0, failures: [`spawn error: ${e.message}`], raw: String(e) }));
  });
}

// create_sim builds the ARENA the auto-researcher must solve: a battery of
// diverse simulation environments (edge cases, spread, adversarial input layouts)
// checked with INVARIANTS rather than answer-encoding. Passing every environment
// forces a genuinely robust turtle. The model supplies structured params; we emit
// correct Lua so the arena is always valid — only the turtle program is iterated.
interface SimParams {
  name?: string;
  inputItem: string;
  outputItem: string;
  perCraft?: number;      // ingredients per craft (default 9 = full 3x3)
  inputAbove?: boolean;   // input chest above the turtle (default true); output is the other side
  worlds?: number[];      // OPTIONAL explicit input counts (overrides the default battery)
}

// Distribute N input items across chest slots. "normal" packs 64-stacks;
// "scatter" spreads into many small odd stacks to stress drain/consolidation.
function layout(inItem: string, N: number, mode: "normal" | "scatter"): string {
  const parts: string[] = [];
  let r = N;
  const chunks = mode === "scatter" ? [3, 7, 1, 11, 5, 9, 13, 2] : [64];
  let ci = 0;
  while (r > 0) {
    const c = Math.min(mode === "scatter" ? chunks[ci++ % chunks.length] : 64, r);
    parts.push(`{ name = '${inItem}', count = ${c} }`);
    r -= c;
  }
  return parts.join(", ");
}

function genSpec(p: SimParams): { yaml: string; worlds: number[]; per: number; maxScore: number } {
  const per = p.perCraft ?? 9;
  const above = p.inputAbove !== false;
  const inC = above ? [8, 65, 8] : [8, 63, 8];
  const outC = above ? [8, 63, 8] : [8, 65, 8];
  const inKey = inC.join(","), outKey = outC.join(",");
  const inItem = p.inputItem, outItem = p.outputItem;

  // The environment battery: edge cases + a spread of sizes + an adversarial
  // input layout. Each must be handled by ONE program → robustness.
  type Env = { N: number; mode: "normal" | "scatter"; note: string };
  const envs: Env[] = (p.worlds && p.worlds.length)
    ? p.worlds.map((N) => ({ N, mode: "normal" as const, note: "explicit" }))
    : [
        { N: 0, mode: "normal", note: "empty input" },
        { N: per - 1, mode: "normal", note: "below one batch (all leftover)" },
        { N: per, mode: "normal", note: "exactly one" },
        { N: per + 1, mode: "normal", note: "one + leftover" },
        { N: 5 * per, mode: "normal", note: "several, no remainder" },
        { N: 7 * per + Math.max(1, per - 2), mode: "normal", note: "several + odd remainder" },
        { N: 30 * per + 4, mode: "normal", note: "large, awkward remainder" },
        { N: 11 * per + 5, mode: "scatter", note: "input scattered across small stacks" },
      ].filter((e) => e.N >= 0);

  const node = (i: number, e: Env) => `    - label: env_${i}_${e.note.replace(/[^a-z0-9]+/gi, "_")}
      collect: true
      program: "@file:prog.lua"
      world_lua: |
        local N = ${e.N}   -- ${e.note}
        return {
          start = { x = 8, y = 64, z = 8, facing = 'south', fuel = 20000 },
          recipes = { { output = { name = '${outItem}', count = 1 }, shapeless = { ['${inItem}'] = ${per} } } },
          chests = { ['${inKey}'] = { ${layout(inItem, e.N, e.mode)} }, ['${outKey}'] = {} },
          test = function(sim)
            local P = ${per}
            local function count(x, y, z, name)
              local ch, t = sim.chest(x, y, z), 0
              if ch then for _, it in ipairs(ch) do if it.name == name then t = t + it.count end end end
              return t
            end
            local function others(x, y, z, keep)
              local ch, t = sim.chest(x, y, z), 0
              if ch then for _, it in ipairs(ch) do if it.name ~= keep then t = t + it.count end end end
              return t
            end
            local out = count(${outC.join(", ")}, '${outItem}')       -- produced
            local left = count(${inC.join(", ")}, '${inItem}')        -- returned
            local inv, held, heldIn = sim.inventory(), 0, 0
            for k = 1, 16 do if inv[k] then held = held + inv[k].count
              if inv[k].name == '${inItem}' then heldIn = heldIn + inv[k].count end end end
            -- INVARIANTS (hold for any correct turtle, no answer encoded):
            sim.assertEq(out * P + left + heldIn, N, 'conservation: input items neither lost nor duplicated')
            sim.assertTrue(left < P, 'maximality: a full craftable batch was left behind')
            sim.assertEq(held, 0, 'terminal: turtle inventory emptied')
            sim.assertEq(others(${outC.join(", ")}, '${outItem}'), 0, 'purity: output chest holds only the product')
            sim.assertEq(others(${inC.join(", ")}, '${inItem}'), 0, 'purity: input chest holds only the ingredient')
          end,
        }`;
  const yaml = `# Generated by create_sim — the arena for the auto-researcher.
# Compression turtle: ${inItem} -> ${outItem} (${per} -> 1). ${envs.length} environments, invariant-checked.
task: >-
  Stationary crafty turtle. Input chest ${above ? "ABOVE" : "BELOW"} holds ${inItem};
  compress ${per} -> 1 into ${outItem} via turtle.craft(); deposit the product in the
  ${above ? "BELOW" : "ABOVE"} chest; return leftover (< ${per}) to the input chest. Must
  work for EVERY environment: empty input, sub-batch amounts, large amounts, and
  input scattered across many small stacks.
sim:
  timeout_ms: 60000
  nodes:
${envs.map((e, i) => node(i + 1, e)).join("\n")}
`;
  return { yaml, worlds: envs.map((e) => e.N), per, maxScore: envs.length * 5 };
}

export default function piTurtle(pi: ExtensionAPI) {
  (pi.registerTool as (t: unknown) => unknown)({
    name: "create_sim",
    label: "Create Sim",
    description:
      "Build the ARENA the turtle must solve, for an input -> craft -> output compression " +
      "turtle. Give the input item, output item, and how many inputs make one output. This " +
      "writes a battery of diverse environments (empty input, sub-batch amounts, large " +
      "amounts, input scattered across many small stacks) checked with INVARIANTS " +
      "(conservation, maximality, empty inventory, chest purity) — so only a robust program " +
      "passes them all. Call this FIRST, before writing any program.",
    promptSnippet: "Build the environment arena for a compression turtle (input item, output item, ratio).",
    parameters: Type.Object({
      inputItem: Type.String({ description: "Item id consumed, e.g. minecraft:melon_slice" }),
      outputItem: Type.String({ description: "Item id produced, e.g. minecraft:melon" }),
      perCraft: Type.Optional(Type.Number({ description: "Inputs per output (default 9 = full 3x3 grid)" })),
      inputAbove: Type.Optional(Type.Boolean({ description: "Input chest is ABOVE the turtle (default true); output is the opposite side" })),
      worlds: Type.Optional(Type.Array(Type.Number(), { description: "Input counts to test, e.g. [63, 140]" })),
    }),
    async execute(_id: string, params: SimParams) {
      if (!params.inputItem || !params.outputItem) {
        return { content: [{ type: "text" as const, text: "create_sim needs inputItem and outputItem." }], details: { error: "missing" } };
      }
      const g = genSpec(params);
      writeFileSync(join(SIM_DIR, "spec.yaml"), g.yaml);
      const lines = g.worlds.map((N) => `  - N=${N} input`);
      return {
        content: [{ type: "text" as const, text:
          `Arena created (${params.inputItem} -> ${params.outputItem}, ${g.per} -> 1): ` +
          `${g.worlds.length} environments, ${g.maxScore} invariant checks total.\n${lines.join("\n")}\n\n` +
          `Each environment checks the same invariants (conservation, maximality, empty ` +
          `inventory, chest purity). Write ONE turtle program and iterate with turtle_sim ` +
          `until it passes ALL ${g.maxScore}/${g.maxScore} — it must handle empty input, ` +
          `sub-batch amounts, large amounts, and scattered stacks.` }],
        details: { environments: g.worlds, perCraft: g.per, maxScore: g.maxScore },
      };
    },
  });

  (pi.registerTool as (t: unknown) => unknown)({
    name: "turtle_sim",
    label: "Turtle Sim",
    description:
      "Test a CC:Tweaked turtle program against the craftos sim. Submit the FULL Lua " +
      "program; it is written to prog.lua and run through every sim node. Returns the " +
      "score (number of postconditions passed) and the failing assertions. Iterate: read " +
      "the failures, fix the program, resubmit, until the score reaches the maximum.",
    promptSnippet: "Test a turtle program against the craftos sim; returns score + failing assertions.",
    parameters: Type.Object({
      program: Type.String({ description: "The complete CC:Tweaked Lua turtle program to test." }),
    }),
    async execute(_id: string, params: { program: string }) {
      writeFileSync(join(SIM_DIR, "prog.lua"), params.program);
      const r = await runSim();
      const head =
        r.total > 0
          ? `score: ${r.score}/${r.total} postconditions passed` +
            (r.score === r.total ? "  ✅ ALL PASS — done." : "")
          : "score: 0 — the program did not run (syntax/runtime error).";
      const fails = r.failures.length ? "\nfailing assertions:\n" + r.failures.map((f) => "  " + f).join("\n") : "";
      const hint =
        r.score === r.total && r.total > 0
          ? ""
          : "\n\nFix the program to satisfy the failing assertions, then call turtle_sim again with the full updated program.";
      return {
        content: [{ type: "text" as const, text: head + fails + hint }],
        details: { score: r.score, total: r.total, failures: r.failures },
      };
    },
  });

  (pi.registerTool as (t: unknown) => unknown)({
    name: "publish_gist",
    label: "Publish Gist",
    description:
      "Publish the finished turtle program (prog.lua) and its sim spec (spec.yaml) " +
      "to a GitHub gist via gh, and return the gist URL. Call this AFTER the program " +
      "passes every sim postcondition (turtle_sim score is maxed).",
    promptSnippet: "Publish the passing turtle program + spec to a GitHub gist; returns the URL.",
    parameters: Type.Object({
      description: Type.Optional(Type.String({ description: "Gist description." })),
      public: Type.Optional(Type.Boolean({ description: "Make the gist public (default: false / secret)." })),
    }),
    async execute(_id: string, params: { description?: string; public?: boolean }) {
      const prog = join(SIM_DIR, "prog.lua");
      const spec = join(SIM_DIR, "spec.yaml");
      const files = [prog, spec].filter(existsSync);
      if (!files.length) {
        return { content: [{ type: "text" as const, text: "publish failed: prog.lua not found — write and test a program first." }],
                 details: { error: "no_files" } };
      }
      const desc = params.description || "CC:Tweaked turtle program (passed the craftos sim)";
      const args = ["gist", "create", "-d", desc, ...(params.public ? ["--public"] : []), ...files];
      const r = await run("gh", args, SIM_DIR);
      const url = (r.stdout.trim().match(/https?:\/\/\S+/) || [])[0];
      if (r.code !== 0 || !url) {
        return { content: [{ type: "text" as const,
          text: `publish failed (exit ${r.code}). Is gh installed and authenticated (gh auth status)?\n${(r.stderr || r.stdout).trim().slice(0, 500)}` }],
          details: { error: "gh_failed", code: r.code } };
      }
      return { content: [{ type: "text" as const, text: `Published: ${url}` }], details: { url } };
    },
  });
}
