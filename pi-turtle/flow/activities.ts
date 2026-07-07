// Temporal activity: the RESEARCHER. Input is an arena.yaml (a sim spec). A pi-SDK
// glm agent, restricted to a turtle_sim tool, writes a Lua program and iterates
// against the arena's invariants until they all pass. Returns the program.
import { createAgentSession, AuthStorage, ModelRegistry, SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dirname, "..", "..");
const MODELS = join(REPO, "pi-turtle", "agent", "models.json");
const PORT = process.env.TURTLE_PORT || "8790";
const RUN_SIM = join(REPO, "spike", "melon-loop", "bin", "run_sim.py");

export type ResearchResult = {
  passed: boolean; score: number; total: number; program: string; attempts: number; error?: string;
};

function readSkill(name: string): string {
  const p = join(REPO, "languages", "skills", name, "SKILL.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
// pick the abstract skill that matches the arena, from the arena text alone
function skillFor(arena: string): string {
  if (/recipes|craft/i.test(arena)) return readSkill("turtle-crafter-compressor");
  if (/sorted|consolidat/i.test(arena)) return readSkill("turtle-sorter");
  return readSkill("cc-tweaked");
}

function runSim(specPath: string): { score: number; total: number; failures: string[] } {
  const r = spawnSync("uv", ["run", RUN_SIM, "--port", PORT, "--spec", specPath], { cwd: REPO, encoding: "utf8", timeout: 120000 });
  const err = (r.stderr || "") + (r.stdout || "");
  const m = err.match(/passed=(\d+)\s+failed=(\d+)/);
  const score = m ? parseInt(m[1], 10) : 0;
  const total = m ? parseInt(m[1], 10) + parseInt(m[2], 10) : 0;
  const failures = (err.match(/^\s*FAIL\s+-.*$/gm) || []).map((s) => s.trim());
  return { score, total, failures };
}

export async function research(arena: string): Promise<ResearchResult> {
  const dir = mkdtempSync(join(tmpdir(), "turtle-arena-"));
  const specPath = join(dir, "arena.yaml");
  writeFileSync(specPath, arena);
  const progPath = join(dir, "prog.lua");
  const task = (arena.match(/^task:\s*(.*)$/m) || [, "Make a turtle that passes the arena."])[1];
  const skill = skillFor(arena);

  const auth = AuthStorage.create();
  const reg = ModelRegistry.create(auth, MODELS);
  const model = reg.find("ollama", process.env.TURTLEFLOW_MODEL || "glm-5.2");
  if (!model) return { passed: false, score: 0, total: 0, program: "", attempts: 0, error: "model ollama/glm-5.2 not found" };

  let best = { program: "", score: -1, total: 0, passed: false };
  let attempts = 0;
  const turtleSim = defineTool({
    name: "turtle_sim",
    description: "Test a full CC:Tweaked Lua turtle program against the arena. Returns score (invariants passed) and the failing assertions. Submit the COMPLETE program; iterate until failed=0.",
    parameters: Type.Object({ program: Type.String({ description: "The complete Lua program." }) }),
    execute: async (_id: string, { program }: { program: string }) => {
      attempts++;
      writeFileSync(progPath, program);
      const { score, total, failures } = runSim(specPath);
      if (score > best.score) best = { program, score, total, passed: total > 0 && score === total };
      const head = total > 0 ? `score: ${score}/${total}${score === total ? "  ✅ ALL PASS" : ""}` : "score: 0 (program errored)";
      const fails = failures.length ? "\nfailing:\n" + failures.map((f) => "  " + f).join("\n") : "";
      return { content: [{ type: "text", text: head + fails }], details: { score, total } };
    },
  });

  const { session } = await createAgentSession({
    model, authStorage: auth, modelRegistry: reg,
    sessionManager: SessionManager.inMemory(),
    customTools: [turtleSim], tools: ["turtle_sim"],
  });
  await session.prompt(
    `Write a CC:Tweaked Lua turtle program and get it passing. ${task}\n\n` +
    `Use the turtle_sim tool: submit your FULL program, read the failing invariants, fix, and resubmit ` +
    `until failed=0. Do not stop until every check passes.\n\nGuidance:\n${skill}`);
  session.dispose();
  return { ...best, attempts };
}
