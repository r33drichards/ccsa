// Temporal-backed MCP task server: exposes the turtle RESEARCHER.
//   tool  research_trigger({ task, environments }) -> { workflowId }   (you build the arena)
//   tool  research_status({ workflowId })          -> {running} | {ok, files:{prog.lua}} | {error}
//   resources  skill://<name>  -> every languages/skills SKILL.md (reference for the sub-agent)
//   (SKILLS_AS_TOOLS=1 also mirrors each skill as a skill_<name> tool for resource-less clients)
// The sub-agent (behind the workflow) writes the turtle Lua; the caller only builds the arena.
// Transport: HTTP (StreamableHTTP at /mcp) when MCP_HTTP_PORT is set (deploy), else stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttp } from "node:http";
import { Client, Connection } from "@temporalio/client";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zEnv, arenaYaml, type Env } from "./arena-object.ts";
import { buildSystemPrompt } from "./sim.ts";
import { initTelemetry, emitLog } from "./telemetry.ts";

initTelemetry("turtle-research-mcp"); // OTLP logs/traces from the MCP server

const REPO = join(import.meta.dirname, "..", "..");
const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const uiBase = process.env.TEMPORAL_UI_URL || "http://localhost:8233";
const taskQueue = "turtle";
const client = new Client({ connection: await Connection.connect({ address }) });

// all languages/skills, discovered once (recursively, incl. superpowers) — exposed
// over MCP as skill://<name> resources (and, if SKILLS_AS_TOOLS, also as tools for
// clients that don't surface MCP resources). These are reference material for the
// SUB-AGENT that writes the Lua; the caller only needs the research_trigger description.
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

// SKILLS_AS_TOOLS (opt-in): also expose each skill as a tool. Precomputed once.
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

const TRIGGER_DESC =
  "Get a working, sim-verified Minecraft CC:Tweaked (ComputerCraft) TURTLE PROGRAM for ANY turtle task " +
  "(auto-sorter, item compressor, farm harvester, miner, builder — anything).\n\n" +
  "YOUR ROLE — read this first: you DEFINE THE TEST (an 'arena'); a separate coding SUB-AGENT writes the " +
  "turtle Lua program. Do NOT write, plan, or think about the turtle program's Lua yourself — that is the " +
  "sub-agent's entire job. You ONLY describe (a) the world the turtle runs in and (b) the INVARIANTS a correct " +
  "turtle must end up satisfying. The sub-agent then writes a Lua program, runs it in a headless ComputerCraft " +
  "simulator against every environment you defined, reads the failing assertions, and rewrites its program " +
  "until ALL your invariants pass.\n\n" +
  "This tool is ASYNC: it returns { workflowId, ui } immediately (ui = a live dashboard to watch). It does NOT " +
  "return the program here — poll research_status(workflowId) to get the finished program in files['prog.lua'].\n\n" +
  "INPUT = the arena (fully specified below; you never need to look anything up):\n" +
  "- `task`: one plain-English line describing what the turtle should do (guides the sub-agent). Any task.\n" +
  "- `environments`: one or more simulated worlds the turtle must ALL pass (use several varied ones — empty, " +
  "small, large, edge cases — so the result is robust, not overfit). Each environment object has:\n" +
  "  - `start` (optional): { x, y, z, facing, fuel }. Default { x:8, y:64, z:8, facing:'south', fuel:20000 }. " +
  "The turtle's adjacent blocks are: up = 8,65,8 ; down = 8,63,8 ; front(south) = 8,64,9 ; it can turn to reach " +
  "the other horizontal sides.\n" +
  "  - `chests` (optional): a map from \"x,y,z\" to a list of { name, count } slots (pre-fill the world's chests). " +
  "For a DOUBLE chest (two blocks sharing one 54-slot inventory): { items:[{name,count}...], double:\"x,y,z\", capacity?:N }.\n" +
  "  - `recipes` (optional): needed only if the turtle must turtle.craft(). Each: { output:{name,count}, " +
  "shapeless:{ \"item\": N } } (N grid slots of that item) or { output, shaped:[ nine item names or '' ] }.\n" +
  "  - `nodes` (optional): extra sim computers YOU wire up alongside the turtle — this is how you build MULTI-NODE " +
  "scenarios like GPS. Each: { position:[x,y,z], program }. Every node gets these injected globals: NET (this run's " +
  "wireless network id), emit(...), setpos(x,y,z), done(); open a wireless modem with " +
  "periphemu.create('top','modem',NET,true). When you add nodes, the turtle auto-equips a modem and publishes its " +
  "position, so gps.locate() works from the turtle program.\n" +
  "  - `nilSim` (optional bool): run the turtle program with the `sim` global NIL'd, forcing the REAL-device code " +
  "path (gps.locate()/peripherals/config instead of sim.*). The invariant test still verifies the real end state. " +
  "Pair with `nodes` (gps hosts) to prove the turtle navigates by GPS, not by the simulator.\n" +
  "  - `test`: a short Lua snippet — the body of test(sim) — asserting the invariants. This is the ONLY Lua you " +
  "write (it checks the world AFTER the turtle runs; it is NOT the turtle program). sim API available inside it: " +
  "sim.chest(x,y,z) -> list of {name,count} or nil; sim.inventory() -> [1..16] of {name,count} or nil; " +
  "sim.assertEq(actual, expected, msg); sim.assertTrue(cond, msg); sim.assertPos(x,y,z,msg); sim.assertFacing(f,msg); " +
  "sim.block(x,y,z). Lua math.* is available.\n\n" +
  "WRITE INVARIANTS, NOT THE ANSWER: assert PROPERTIES any correct turtle satisfies — conservation (nothing lost " +
  "or duplicated), maximality (no work left undone), terminal state (e.g. inventory emptied), purity (only the " +
  "expected items in each chest) — rather than one hardcoded number. That's what forces a robust turtle.\n\n" +
  "EXAMPLE — an in-place auto-SORTER environment (front chest full of fragmented, unsorted items; the invariant " +
  "checks each chest ends up conserved, same items merged to ceil(count/64) stacks, and slots ordered by item " +
  "name):\n" +
  "  { \"task\": \"sort each adjacent chest in place\",\n" +
  "    \"environments\": [ { \"chests\": { \"8,64,9\": [ {\"name\":\"minecraft:cobblestone\",\"count\":40}, " +
  "{\"name\":\"minecraft:dirt\",\"count\":10}, {\"name\":\"minecraft:cobblestone\",\"count\":30} ] },\n" +
  "        \"test\": \"local ch=sim.chest(8,64,9)\\nlocal counts,slots,sorted,prev={},{},true,nil\\nif ch then for _,it in ipairs(ch) do counts[it.name]=(counts[it.name] or 0)+it.count slots[it.name]=(slots[it.name] or 0)+1 if prev and it.name<prev then sorted=false end prev=it.name end end\\nsim.assertEq(counts['minecraft:cobblestone'] or 0,70,'cobble preserved')\\nsim.assertEq(counts['minecraft:dirt'] or 0,10,'dirt preserved')\\nsim.assertEq(slots['minecraft:cobblestone'] or 0,2,'cobble consolidated')\\nsim.assertTrue(sorted,'sorted by name')\" } ] }\n\n" +
  "EXAMPLE — a GPS test env (you wire up 4 GPS host computers around the turtle via `nodes`, and set `nilSim` so the " +
  "program must locate itself with gps.locate() like a real turtle, not sim.pos()):\n" +
  "  { \"task\": \"navigate to the target using GPS\",\n" +
  "    \"environments\": [ { \"start\": {\"x\":8,\"y\":64,\"z\":8,\"facing\":\"south\",\"fuel\":100}, \"nilSim\": true,\n" +
  "        \"nodes\": [\n" +
  "          {\"position\":[28,64,8],   \"program\":\"periphemu.create('top','modem',NET,true) shell.run('gps','host',28,64,8)\"},\n" +
  "          {\"position\":[8,84,8],    \"program\":\"periphemu.create('top','modem',NET,true) shell.run('gps','host',8,84,8)\"},\n" +
  "          {\"position\":[8,64,28],   \"program\":\"periphemu.create('top','modem',NET,true) shell.run('gps','host',8,64,28)\"},\n" +
  "          {\"position\":[-12,44,-12],\"program\":\"periphemu.create('top','modem',NET,true) shell.run('gps','host',-12,44,-12)\"} ],\n" +
  "        \"test\": \"sim.assertPos(8,64,11,'reached the target using gps.locate for position')\" } ] }\n" +
  "The 4 GPS hosts MUST be non-coplanar (offsets on +x, +y, +z and one opposite corner as above) or gps.locate() " +
  "returns nil. The turtle program calls gps.locate() to read its position; the arena equips the modem and mirrors " +
  "the turtle's movement to it automatically.";

function buildServer(): McpServer {
  const server = new McpServer({ name: "turtle-research", version: "0.1.0" });

  server.registerTool("research_trigger", {
    description: TRIGGER_DESC,
    inputSchema: {
      task: z.string().describe("One plain-English line: what the turtle must do (guides the sub-agent)."),
      environments: z.array(zEnv).min(1).describe("One or more sim worlds the turtle must ALL pass. Each: { start?, chests?, recipes?, test }. `test` is a short Lua snippet asserting invariants (this is the ONLY Lua you write; you do NOT write the turtle program). Use several varied environments for a robust result."),
      timeoutMs: z.number().int().optional().describe("Per-environment sim timeout ms (default 60000)."),
      maxSteps: z.number().int().positive().optional().describe("Max agent turns (LLM calls) before giving up and returning the best attempt (default 60)."),
      maxTokens: z.number().int().positive().optional().describe("Total LLM token budget for the whole job (sum over every model call incl. compaction summaries). When exceeded, the loop stops and returns the best attempt. Default: unbounded."),
    },
  }, async ({ task, environments, timeoutMs, maxSteps, maxTokens }: { task: string; environments: Env[]; timeoutMs?: number; maxSteps?: number; maxTokens?: number }) => {
    const arena = arenaYaml(task, environments, timeoutMs ?? 60000);
    const systemPrompt = buildSystemPrompt(task, environments, arena);
    const workflowId = "turtle-" + Math.random().toString(36).slice(2, 10);
    await client.workflow.start("researchWorkflow", { args: [{ task, envs: environments, systemPrompt, maxSteps, maxTokens }], taskQueue, workflowId, workflowExecutionTimeout: "6 hours" });
    emitLog("info", `research started: ${workflowId}`, { "workflow.id": workflowId, task, environments: environments.length });
    const body = { workflowId, ui: `${uiBase}/namespaces/default/workflows/${workflowId}`, environments: environments.length };
    return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
  });

  server.registerTool("research_status", {
    description:
      "Get the result of a turtle-program-generation job started by `research_trigger` (step 2 of 2). Pass the " +
      "`workflowId` from research_trigger. While the sub-agent is still writing/iterating: { type:'running', ui } " +
      "— poll again every ~10 seconds. When a program passes every invariant in your arena: { type:'ok', score, " +
      "files:{ 'prog.lua': <the complete CC:Tweaked Lua turtle program> } } — 'prog.lua' is the deliverable, " +
      "ready to run on a real turtle. If it could not fully pass: { type:'error', msg, files:{ 'prog.lua': " +
      "<best attempt> } }. `ui` links to the live dashboard.",
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
        ? { type: "ok", score: `${r.score}/${r.total}`, attempts: r.attempts, steps: r.steps, tokens: r.tokens, report: r.report, ui, files: { "prog.lua": r.program } }
        // never fully passed -> ERROR state; the best attempt is metadata, not a deliverable
        : { type: "error", msg: `did not pass — best ${r.score}/${r.total} invariants after ${r.attempts} attempts`,
            score: r.score, total: r.total, attempts: r.attempts, steps: r.steps, tokens: r.tokens, report: r.report, ui,
            ...(r.program ? { files: { "prog.lua": r.program } } : {}) };
    } else out = { type: "error", msg: `workflow ${desc.status.name}`, ui };
    if (out.type !== "running") emitLog(out.type === "ok" ? "info" : "error", `research ${out.type}: ${workflowId}`, { "workflow.id": workflowId, ...out, files: undefined });
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
  });

  // skills over MCP: each SKILL.md as a skill://<name> resource (for the sub-agent's reference)
  for (const { name, path } of SKILLS) {
    server.registerResource(name, `skill://${name}`, { title: `${name} skill`, mimeType: "text/markdown" },
      async (uri: URL) => ({ contents: [{ uri: uri.href, text: readFileSync(path, "utf8") }] }));
  }
  // skills as tools (opt-in via SKILLS_AS_TOOLS): the tool description is the skill's "when to use"
  for (const { toolName, desc, md } of SKILL_TOOLS) {
    server.registerTool(toolName, { description: desc, inputSchema: {} },
      async () => ({ content: [{ type: "text" as const, text: md }] }));
  }

  return server;
}

const httpPort = process.env.MCP_HTTP_PORT || process.env.PORT;
if (httpPort) {
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
  http.listen(Number(httpPort), "0.0.0.0", () => console.error(`[mcp] HTTP on :${httpPort}/mcp — research_trigger, research_status, ${SKILLS.length} skill resources, ${SKILL_TOOLS.length} skill tools`));
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error(`[mcp] stdio ready — research_trigger, research_status, ${SKILLS.length} skill resources, ${SKILL_TOOLS.length} skill tools`);
}
