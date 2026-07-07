// Temporal-backed MCP task server: exposes the turtle researcher.
//   tool  research_trigger({ arena })  -> { workflowId }         (starts the workflow)
//   tool  research_status({ workflowId }) -> { type:'running' } | { type:'ok', files:{'prog.lua'} } | { type:'error', msg }
//   resources  skill://<name>  -> the turtle skills as markdown
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, Connection } from "@temporalio/client";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const taskQueue = "turtle";
const client = new Client({ connection: await Connection.connect({ address }) });

const server = new McpServer({ name: "turtle-research", version: "0.1.0" });

server.registerTool("research_trigger", {
  description: "Start a turtle-research job. Input: the full arena.yaml (a craftgen sim spec — world + invariant checks). Returns a workflowId; poll research_status with it. The researcher (glm, sandboxed to a sim tool) writes a CC:Tweaked Lua turtle and iterates until every invariant passes.",
  inputSchema: { arena: z.string().describe("The arena.yaml sim spec.") },
}, async ({ arena }: { arena: string }) => {
  const workflowId = "turtle-" + Math.random().toString(36).slice(2, 10);
  await client.workflow.start("researchWorkflow", { args: [arena], taskQueue, workflowId });
  const body = { workflowId, ui: `http://localhost:8233/namespaces/default/workflows/${workflowId}` };
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
});

server.registerTool("research_status", {
  description: "Check a turtle-research job by workflowId. Returns {type:'running'} while working, {type:'ok', files:{'prog.lua':<lua>}} when a passing program was found, or {type:'error', msg} on failure.",
  inputSchema: { workflowId: z.string() },
}, async ({ workflowId }: { workflowId: string }) => {
  const h = client.workflow.getHandle(workflowId);
  const desc = await h.describe();
  let out: Record<string, unknown>;
  if (desc.status.name === "RUNNING") {
    out = { type: "running", workflowId };
  } else if (desc.status.name === "COMPLETED") {
    const r: any = await h.result();
    out = r.passed
      ? { type: "ok", score: `${r.score}/${r.total}`, attempts: r.attempts, files: { "prog.lua": r.program } }
      : { type: "error", msg: `did not pass (best ${r.score}/${r.total})`, files: { "prog.lua": r.program } };
  } else {
    out = { type: "error", msg: `workflow ${desc.status.name}` };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
});

// bonus: ship the skills as MCP resources
for (const name of ["turtle-sorter", "turtle-crafter-compressor", "cc-tweaked", "craftos-sim"]) {
  const p = join(REPO, "languages", "skills", name, "SKILL.md");
  if (!existsSync(p)) continue;
  server.registerResource(name, `skill://${name}`, { title: `${name} skill`, mimeType: "text/markdown" },
    async (uri: URL) => ({ contents: [{ uri: uri.href, text: readFileSync(p, "utf8") }] }));
}

await server.connect(new StdioServerTransport());
console.error("[mcp] turtle-research server ready on stdio");
