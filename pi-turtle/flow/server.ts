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

function buildServer(): McpServer {
  const server = new McpServer({ name: "turtle-research", version: "0.1.0" });

  server.registerTool("research_trigger", {
    description: "Start a turtle-research job. Input: the full arena.yaml (a craftgen sim spec — world + invariant checks). Returns a workflowId; poll research_status with it. The researcher (glm, sandboxed to a sim tool) writes a CC:Tweaked Lua turtle and iterates until every invariant passes.",
    inputSchema: { arena: z.string().describe("The arena.yaml sim spec.") },
  }, async ({ arena }: { arena: string }) => {
    const workflowId = "turtle-" + Math.random().toString(36).slice(2, 10);
    await client.workflow.start("researchWorkflow", { args: [arena], taskQueue, workflowId });
    const body = { workflowId, ui: `${uiBase}/namespaces/default/workflows/${workflowId}` };
    return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
  });

  server.registerTool("research_status", {
    description: "Check a turtle-research job by workflowId. Returns {type:'running'} while working, {type:'ok', files:{'prog.lua':<lua>}} when a passing program was found, or {type:'error', msg} on failure.",
    inputSchema: { workflowId: z.string() },
  }, async ({ workflowId }: { workflowId: string }) => {
    const h = client.workflow.getHandle(workflowId);
    const desc = await h.describe();
    let out: Record<string, unknown>;
    if (desc.status.name === "RUNNING") out = { type: "running", workflowId };
    else if (desc.status.name === "COMPLETED") {
      const r: any = await h.result();
      out = r.passed
        ? { type: "ok", score: `${r.score}/${r.total}`, attempts: r.attempts, files: { "prog.lua": r.program } }
        : { type: "error", msg: `did not pass (best ${r.score}/${r.total})`, files: { "prog.lua": r.program } };
    } else out = { type: "error", msg: `workflow ${desc.status.name}` };
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
  });

  for (const { name, path } of SKILLS) {
    server.registerResource(name, `skill://${name}`, { title: `${name} skill`, mimeType: "text/markdown" },
      async (uri: URL) => ({ contents: [{ uri: uri.href, text: readFileSync(path, "utf8") }] }));
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
  http.listen(Number(httpPort), "0.0.0.0", () => console.error(`[mcp] HTTP on :${httpPort}/mcp  (${SKILLS.length} skills)`));
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error(`[mcp] stdio ready (${SKILLS.length} skills)`);
}
