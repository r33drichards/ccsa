// pi-turtle — a Pi package for making CC:Tweaked turtle programs.
//
// Phase 2 core: the `turtle_sim` tool. A (restricted) sub-agent submits a full
// Lua turtle program; the tool runs it against the craftos sim on the
// self-hosted languages server and returns the score (# postconditions passed)
// plus the failing assertions. The agent iterates until the score is maxed —
// the autoresearch loop, expressed through one high-level tool so a small model
// can drive it reliably (no bash, no hand-written run_js).
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

export default function piTurtle(pi: ExtensionAPI) {
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
