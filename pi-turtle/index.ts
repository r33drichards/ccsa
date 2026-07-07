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

// Deterministically generate a craftgen spec.yaml for an input -> craft -> output
// compression turtle. The model supplies structured params; we emit correct Lua
// (chests, recipe registration, auto-derived postconditions) so the SIM is always
// valid — the turtle program is what gets iterated, not the test.
interface SimParams {
  name?: string;
  inputItem: string;
  outputItem: string;
  perCraft?: number;      // ingredients per craft (default 9 = full 3x3)
  inputAbove?: boolean;   // input chest above the turtle (default true); output is the other side
  worlds?: number[];      // input counts per sim world
}

function genSpec(p: SimParams): { yaml: string; worlds: number[]; per: number; maxScore: number } {
  const per = p.perCraft ?? 9;
  const above = p.inputAbove !== false;
  const inC = above ? [8, 65, 8] : [8, 63, 8];
  const outC = above ? [8, 63, 8] : [8, 65, 8];
  const inKey = inC.join(","), outKey = outC.join(",");
  const worlds = (p.worlds && p.worlds.length) ? p.worlds : [per * 7, per * 15 + Math.max(1, per - 4)];
  const inItem = p.inputItem, outItem = p.outputItem;
  const stk = (n: number) => {
    const parts: string[] = []; let r = n;
    while (r > 0) { const c = Math.min(64, r); parts.push(`{ name = '${inItem}', count = ${c} }`); r -= c; }
    return parts.join(", ");
  };
  const node = (i: number, N: number) => `    - label: world_${i}
      collect: true
      program: "@file:prog.lua"
      world_lua: |
        local N = ${N}
        return {
          start = { x = 8, y = 64, z = 8, facing = 'south', fuel = 20000 },
          recipes = { { output = { name = '${outItem}', count = 1 }, shapeless = { ['${inItem}'] = ${per} } } },
          chests = { ['${inKey}'] = { ${stk(N)} }, ['${outKey}'] = {} },
          test = function(sim)
            local function sumIn(x, y, z, name)
              local ch, t = sim.chest(x, y, z), 0
              if ch then for _, it in ipairs(ch) do if it.name == name then t = t + it.count end end end
              return t
            end
            sim.assertEq(sumIn(${outC.join(", ")}, '${outItem}'), math.floor(N / ${per}), '${outItem} in output chest')
            sim.assertEq(sumIn(${inC.join(", ")}, '${inItem}'), N % ${per}, 'leftover ${inItem} returned to input chest')
            local inv, held = sim.inventory(), 0
            for k = 1, 16 do if inv[k] then held = held + inv[k].count end end
            sim.assertEq(held, 0, 'turtle inventory emptied')
          end,
        }`;
  const yaml = `# Generated by create_sim. Compression turtle: ${inItem} -> ${outItem} (${per} -> 1).
task: >-
  Stationary crafty turtle. Input chest ${above ? "ABOVE" : "BELOW"} holds ${inItem};
  compress ${per} -> 1 into ${outItem} via turtle.craft(); deposit blocks in the
  ${above ? "BELOW" : "ABOVE"} chest; return leftover (< ${per}) to the input chest.
sim:
  timeout_ms: 60000
  nodes:
${worlds.map((N, i) => node(i + 1, N)).join("\n")}
`;
  return { yaml, worlds, per, maxScore: worlds.length * 3 };
}

export default function piTurtle(pi: ExtensionAPI) {
  (pi.registerTool as (t: unknown) => unknown)({
    name: "create_sim",
    label: "Create Sim",
    description:
      "Set up the test the turtle must pass, for an input -> craft -> output compression " +
      "turtle. Give the input item, output item, and how many inputs make one output. This " +
      "writes a fresh spec.yaml (chests, recipe, and pass/leftover/empty-inventory checks) " +
      "that turtle_sim then tests against. Call this FIRST, before writing any program.",
    promptSnippet: "Create the sim/test for a compression turtle (input item, output item, ratio).",
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
      const lines = g.worlds.map((N) =>
        `  - ${N} ${params.inputItem} -> ${Math.floor(N / g.per)} ${params.outputItem}, ${N % g.per} leftover`);
      return {
        content: [{ type: "text" as const, text:
          `Sim created (${params.inputItem} -> ${params.outputItem}, ${g.per} -> 1). ` +
          `${g.worlds.length} world(s), max score ${g.maxScore}:\n${lines.join("\n")}\n\n` +
          `Now write the turtle program and test it with turtle_sim until the score is ${g.maxScore}/${g.maxScore}.` }],
        details: { worlds: g.worlds, perCraft: g.per, maxScore: g.maxScore },
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
