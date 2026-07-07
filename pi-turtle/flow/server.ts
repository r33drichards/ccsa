// Temporal-backed MCP task server: exposes the turtle researcher.
//   tool  research_trigger({ arena })   -> { workflowId }
//   tool  research_status({ workflowId }) -> {type:'running'} | {type:'ok', files:{'prog.lua'}} | {type:'error', msg}
//   resources  skill://<name>  -> all languages/skills as markdown
// Transport: HTTP (StreamableHTTP at /mcp) when MCP_HTTP_PORT is set (for deploy),
// otherwise stdio (for local MCP clients).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttp } from "node:http";
import { Client, Connection } from "@temporalio/client";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zEnv, arenaYaml, type Env } from "./arena-object.ts";
const TRIGGER_DESC =
  "Generate a working, sim-verified Minecraft CC:Tweaked (ComputerCraft) TURTLE PROGRAM for ANY turtle task. " +
  "You DEFINE THE TEST (a structured 'arena' — see the input schema); an autonomous coding sub-agent then writes " +
  "a Lua turtle program, runs it in a headless ComputerCraft simulator against every environment in your arena, " +
  "reads the failing assertions, and rewrites the program until they ALL pass. You do NOT write the turtle Lua. " +
  "Asynchronous: returns { workflowId, ui } immediately (ui = live dashboard); call research_status(workflowId) " +
  "to get the finished program in files['prog.lua'].\n\n" +
  "HOW TO DEFINE THE ARENA (input):\n" +
  "- `task`: one free-text line describing what the turtle should do (guides the sub-agent). Any task — this is " +
  "not a fixed menu.\n" +
  "- `environments`: one or more simulated worlds the turtle must ALL pass (more/varied = more robust). Each has:\n" +
  "  - `start` (optional): { x,y,z, facing, fuel }. Default { x:8,y:64,z:8, facing:'south', fuel:20000 }. The " +
  "turtle's adjacent blocks are up=8,65,8 down=8,63,8 front(south)=8,64,9; it can turn to face other sides.\n" +
  "  - `chests` (optional): map of \"x,y,z\" -> a list of { name, count } slots. For a DOUBLE chest (two blocks, " +
  "one 54-slot inventory) use { items:[...], double:\"x,y,z\", capacity?:N }.\n" +
  "  - `recipes` (optional): enable turtle.craft(); each { output:{name,count}, shapeless:{ item:count } } (N grid " +
  "slots of an item) or { output, shaped:[9 item names or ''] }.\n" +
  "  - `test`: a Lua snippet (the body of test(sim)) that asserts the INVARIANTS a correct turtle must satisfy. " +
  "sim API: sim.chest(x,y,z)->list of {name,count} or nil; sim.inventory()->[1..16] of {name,count} or nil; " +
  "sim.assertEq(actual,expected,msg); sim.assertTrue(cond,msg); sim.assertPos(x,y,z,msg); sim.assertFacing(f,msg); " +
  "sim.block(x,y,z). Lua math.* is available.\n\n" +
  "WRITE INVARIANTS, NOT THE ANSWER: assert PROPERTIES any correct turtle has (conservation: nothing lost or " +
  "duplicated; maximality; terminal state e.g. inventory emptied; purity: only expected items) rather than a " +
  "single hardcoded expected number — that forces a robust turtle across your environments.\n\n" +
  "EXAMPLE ARENAS (illustrative, not the only tasks): a COMPRESSOR (pull an item, turtle.craft() N->1, deposit; " +
  "invariants = conservation + inventory emptied + chest purity), an in-place SORTER (per adjacent chest: same " +
  "items merged to ceil(count/64) stacks and slots ordered by name), a FARM HARVESTER, a miner, a builder — " +
  "anything you can express as a world + invariant test.";


const REPO = join(import.meta.dirname, "..", "..");
const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const uiBase = process.env.TEMPORAL_UI_URL || "http://localhost:8233";
const taskQueue = "turtle";
const client = new Client({ connection: await Connection.connect({ address }) });

// all languages/skills, discovered once (recursively, incl. superpowers)
function findSkills(dir: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "SKILL.md"))) out.push({ name: e, path: join(p, "SKILL.md") });
    out.push(...findSkills(p));
  }
  return out;
}
const seen = new Set<string>();
const SKILLS = findSkills(join(REPO, "languages", "skills")).filter((s) => !seen.has(s.name) && seen.add(s.name));

// extract the frontmatter `description:` (the skill's "when to use")
function skillDescription(md: string): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const lines = fm[1].split("\n");
  const i = lines.findIndex((l) => l.startsWith("description:"));
  if (i < 0) return "";
  const inline = lines[i].slice("description:".length).trim();
  if (inline && !/^[>|][-+]?$/.test(inline)) return inline;
  const cont: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s+\S/.test(lines[j])) cont.push(lines[j].trim());
    else if (lines[j].trim() === "") continue;
    else break;
  }
  return cont.join(" ").trim();
}

// SKILLS_AS_TOOLS: also expose each skill as a tool (for clients that don't
// surface MCP resources). Precomputed once.
const SKILLS_AS_TOOLS = !!process.env.SKILLS_AS_TOOLS;
const SKILL_TOOLS = SKILLS_AS_TOOLS
  ? SKILLS.map((s) => {
      const md = readFileSync(s.path, "utf8");
      return {
        toolName: "skill_" + s.name.replace(/[^a-z0-9]+/gi, "_"),
        desc: (skillDescription(md) || `The ${s.name} skill.`).slice(0, 1000),
        md,
      };
    })
  : [];

function buildServer(): McpServer {
  const server = new McpServer({ name: "turtle-research", version: "0.1.0" });

  server.registerTool("research_trigger", {
    description: TRIGGER_DESC,
    inputSchema: {
      task: z.string().describe("One free-text line: what the turtle must do (guides the sub-agent)."),
      environments: z.array(zEnv).min(1).describe("One or more sim environments the turtle must ALL pass. Each: { start?, chests?, recipes?, test }. `test` is a Lua snippet asserting invariants. Use several varied environments (edge cases) for a robust result."),
      timeoutMs: z.number().int().optional().describe("Per-environment sim timeout ms (default 60000)."),
    },
  }, async ({ task, environments, timeoutMs }: { task: string; environments: Env[]; timeoutMs?: number }) => {
    const arena = arenaYaml(task, environments, timeoutMs ?? 60000);
    const workflowId = "turtle-" + Math.random().toString(36).slice(2, 10);
    await client.workflow.start("researchWorkflow", { args: [arena], taskQueue, workflowId });
    const body = { workflowId, ui: `${uiBase}/namespaces/default/workflows/${workflowId}`, environments: environments.length };
    return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
  });

  server.registerTool("research_status", {
    description:
      "Get the result of a turtle-program-generation job started by `research_trigger` (step 2 of 2). " +
      "Pass the `workflowId` you got from research_trigger. While the agent is still writing/iterating, " +
      "returns { type:'running', ui } — poll again every ~10 seconds. When it has found a program that " +
      "passes every invariant in the arena, returns { type:'ok', score, files:{ 'prog.lua': <the complete " +
      "CC:Tweaked Lua turtle program> } } — 'prog.lua' is the deliverable, ready to run on a real turtle. " +
      "If it could not fully pass, returns { type:'error', msg, files:{ 'prog.lua': <best attempt> } }. " +
      "`ui` is a dashboard link to watch progress.",
    inputSchema: { workflowId: z.string().describe("The workflowId returned by research_trigger.") },
  }, async ({ workflowId }: { workflowId: string }) => {
    const ui = `${uiBase}/namespaces/default/workflows/${workflowId}`;
    const h = client.workflow.getHandle(workflowId);
    const desc = await h.describe();
    let out: Record<string, unknown>;
    if (desc.status.name === "RUNNING") out = { type: "running", workflowId, ui };
    else if (desc.status.name === "COMPLETED") {
      const r: any = await h.result();
      out = r.passed
        ? { type: "ok", score: `${r.score}/${r.total}`, attempts: r.attempts, ui, files: { "prog.lua": r.program } }
        : { type: "error", msg: `did not pass (best ${r.score}/${r.total})`, ui, files: { "prog.lua": r.program } };
    } else out = { type: "error", msg: `workflow ${desc.status.name}`, ui };
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
  });

  for (const { name, path } of SKILLS) {
    server.registerResource(name, `skill://${name}`, { title: `${name} skill`, mimeType: "text/markdown" },
      async (uri: URL) => ({ contents: [{ uri: uri.href, text: readFileSync(path, "utf8") }] }));
  }
  // skills as tools (opt-in): the tool's description is the skill's "when to use"
  for (const { toolName, desc, md } of SKILL_TOOLS) {
    server.registerTool(toolName, { description: desc, inputSchema: {} },
      async () => ({ content: [{ type: "text" as const, text: md }] }));
  }
  return server;
}

const httpPort = process.env.MCP_HTTP_PORT || process.env.PORT;
if (httpPort) {
  // Public HTTP transport (stateless: one server+transport per request).
  const http = createHttp((req, res) => {
    if (req.url?.split("?")[0] !== "/mcp") {
      if (req.url === "/" || req.url === "/health") { res.writeHead(200).end("turtle-research MCP ok"); return; }
      res.writeHead(404).end("not found"); return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : undefined;
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
  });
  http.listen(Number(httpPort), "0.0.0.0", () => console.error(`[mcp] HTTP on :${httpPort}/mcp  (${SKILLS.length} skill resources, ${SKILL_TOOLS.length} skill tools)`));
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error(`[mcp] stdio ready (${SKILLS.length} skill resources, ${SKILL_TOOLS.length} skill tools)`);
}
