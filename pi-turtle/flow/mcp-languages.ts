// Minimal client for the self-hosted mcp-v8 "languages" server (run_js + a
// persistent, isolated /work filesystem keyed by X-MCP-Session-Id). Ported from
// the Python harness (main.py): initialize -> tools/call run_js, transparently
// polling mcp-v8's async execution handles and re-opening a dropped MCP session
// while preserving /work (the X-MCP-Session-Id is stable across reconnects).
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const ASYNC_TOOLS = new Set(["get_execution", "get_execution_output", "cancel_execution", "list_executions"]);
const TERMINAL = new Set(["completed", "succeeded", "success", "failed", "error", "cancelled", "canceled", "timeout"]);

export const WORK_BOOTSTRAP = "/work/bootstrap.js";
export const WORK_SKILLS = "/work/skills";

export type Conn = { url: string; sessionId?: string; workSession: string };

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
}
function headers(c: Conn): Record<string, string> {
  const h: Record<string, string> = { ...JSON_HEADERS, "X-MCP-Session-Id": c.workSession };
  if (c.sessionId) h["Mcp-Session-Id"] = c.sessionId;
  return h;
}
// mcp-v8 replies as SSE with keepalive empty `data:` lines before the real
// `data: {json}` event. Collect every data payload and return the last that parses.
function sseJson(text: string): any {
  const datas = text.split("\n").filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(l.indexOf(":") + 1).trim()).filter(Boolean);
  for (let i = datas.length - 1; i >= 0; i--) { try { return JSON.parse(datas[i]); } catch { /* keep scanning */ } }
  try { return JSON.parse(text); } catch { return {}; }
}

// initialize -> notifications/initialized -> (ready). workSession binds the persistent /work.
export async function open(url: string, workSession: string): Promise<Conn> {
  const c: Conn = { url, workSession };
  const init = await post(url, headers(c), {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "turtle-flow", version: "0.1.0" } },
  }, 30000);
  if (!init.ok) throw new Error(`mcp initialize ${init.status}`);
  c.sessionId = init.headers.get("mcp-session-id") || undefined;
  await post(url, headers(c), { jsonrpc: "2.0", method: "notifications/initialized" }, 30000);
  return c;
}

async function reconnect(c: Conn): Promise<void> {
  const init = await post(c.url, { ...JSON_HEADERS, "X-MCP-Session-Id": c.workSession }, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "turtle-flow", version: "0.1.0" } },
  }, 30000);
  if (!init.ok) throw new Error(`mcp reconnect ${init.status}`);
  c.sessionId = init.headers.get("mcp-session-id") || undefined;
  await post(c.url, headers(c), { jsonrpc: "2.0", method: "notifications/initialized" }, 30000);
}

// one tools/call -> flattened text; re-opens the session once on a 404 (dropped MCP session).
async function rawCall(c: Conn, name: string, args: Record<string, unknown>): Promise<string> {
  const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  let r = await post(c.url, headers(c), payload, 600000);
  if (r.status === 404) { await reconnect(c); r = await post(c.url, headers(c), payload, 600000); }
  if (!r.ok) throw new Error(`tools/call ${name} -> ${r.status}`);
  const result = sseJson(await r.text())?.result ?? {};
  const parts: string[] = [];
  for (const b of result.content ?? []) {
    if (b.type === "text") parts.push(b.text ?? "");
    else if (b.type === "image") parts.push(`[image: ${b.mimeType ?? "image/png"}]`);
    else parts.push(JSON.stringify(b));
  }
  let text = parts.join("\n") || "(no output)";
  if (result.isError) text = `ERROR: ${text}`;
  return text;
}

function executionId(text: string): string | null {
  try { const o = JSON.parse(text); return o && o.execution_id && o.data === undefined && o.status === undefined ? o.execution_id : null; }
  catch { return null; }
}
// mcp-v8 run_js may return {execution_id}; poll get_execution_output to completion so it looks sync.
async function pollExecution(c: Conn, eid: string, timeoutMs = 300000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chunks: string[] = [];
    let offset = 0, status: string | undefined;
    for (;;) {
      const raw = await rawCall(c, "get_execution_output", { execution_id: eid, byte_offset: offset, byte_limit: 65536 });
      let j: any; try { j = JSON.parse(raw); } catch { return raw; }
      chunks.push(j.data ?? "");
      status = j.status;
      if (j.has_more && (j.next_byte_offset ?? offset) > offset) { offset = j.next_byte_offset; continue; }
      break;
    }
    if (status && TERMINAL.has(status)) {
      let out = chunks.join("");
      if (!["completed", "succeeded", "success"].includes(status)) out = `[execution ${status}]\n${out}`;
      return out || "(no output)";
    }
    if (Date.now() > deadline) return `[execution still ${status} after ${timeoutMs}ms]\n${chunks.join("")}`;
    await new Promise((res) => setTimeout(res, 400));
  }
}

// Evaluate JS in the sandbox; resolves async run_js handles to their console output.
export async function runJs(c: Conn, code: string): Promise<string> {
  const text = await rawCall(c, "run_js", { code });
  if (!ASYNC_TOOLS.has("run_js")) { const eid = executionId(text); if (eid) return pollExecution(c, eid); }
  return text;
}

// Seed files into the persistent /work (one batched run_js: mkdir parents + writeFile).
export async function seed(c: Conn, files: Record<string, string>): Promise<void> {
  const parts: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent && parent !== "/work") parts.push(`await fs.mkdir(${JSON.stringify(parent)},{recursive:true}).catch(()=>{});`);
    parts.push(`await fs.writeFile(${JSON.stringify(path)}, ${JSON.stringify(content)});`);
  }
  parts.push(`console.log('seeded ' + ${Object.keys(files).length} + ' file(s)');`);
  await runJs(c, parts.join("\n"));
}
