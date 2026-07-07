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
    description:
      "Generate a working Minecraft CC:Tweaked (ComputerCraft) TURTLE PROGRAM from a test spec. " +
      "This is step 1 of 2 (asynchronous). You provide an `arena.yaml` — a simulation spec (YAML) that " +
      "describes a turtle task as one or more sim 'environments', each with a `world_lua` block whose " +
      "`test(sim)` function asserts the INVARIANTS a correct turtle must satisfy (e.g. items conserved, " +
      "inventory emptied, chest sorted). This tool launches an autonomous coding agent that writes a Lua " +
      "turtle program, runs it against every environment in the arena, reads the failing assertions, and " +
      "rewrites it until they ALL pass. It returns immediately with { workflowId, ui } — `ui` is a live " +
      "dashboard URL to watch it work. It does NOT return the program here; call `research_status` with " +
      "the workflowId to get it. Use this whenever you need a correct, sim-verified CC:Tweaked turtle for a " +
      "task you can express as an arena.yaml (a craftgen-style sim spec).",
    inputSchema: { arena: z.string().describe("The full arena.yaml sim spec: a YAML doc with a `sim.nodes` list, each node a world_lua returning { start, chests, test=function(sim) ...assertions... end }. This defines the turtle task by its invariants.") },
  }, async ({ arena }: { arena: string }) => {
    const workflowId = "turtle-" + Math.random().toString(36).slice(2, 10);
    await client.workflow.start("researchWorkflow", { args: [arena], taskQueue, workflowId });
    const body = { workflowId, ui: `${uiBase}/namespaces/default/workflows/${workflowId}` };
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
