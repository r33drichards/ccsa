#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "ollama",
#     "httpx",
#     "python-dotenv",
# ]
# ///
"""Naive generic multi-MCP mini-swe-agent, driven by Ollama Cloud.

Point it at any number of MCP servers (Streamable HTTP endpoints). It opens a
session per server, unions their tools into one action space (tool names
namespaced ``<server>__<tool>``), and runs a dead-simple agent loop: send the
messages + tools to the model, run whatever tool calls come back, feed the
results in, repeat — until the model answers with no tool call.

The LLM runs on **Ollama Cloud** (https://ollama.com). Set OLLAMA_API_KEY (get a
key at https://ollama.com/settings/keys). The model is any Ollama cloud model id
such as ``gpt-oss:120b`` or ``qwen3-coder:480b``.

    export OLLAMA_API_KEY=...
    uv run main.py --server files=https://host/mcp \
        --task "List the files in the home directory and summarize them."

## Languages preset (picat + craftos WASM sim)

``--languages`` launches the bundled mcp-v8 "languages" server
(``run-languages-mcp.sh``) and connects to it. That server's ``run_js`` tool can
(0,eval) ``languages/bootstrap.js`` and then call the picat / craftos engines,
and read the ``languages/skills`` tree off its filesystem. On ``--languages``:

  1. the mcp-v8 languages server is loaded (spawned + connected);
  2. every skill's SKILL.md under ``languages/skills`` is inlined into the
     system prompt, so the model always knows what skills exist;
  3. the REST of each skill (references/, scripts/, assets/) stays on the
     server's filesystem — the agent reads it on demand with
     ``run_js`` -> ``fs.readFile('<skills>/<name>/...')``.

    export OLLAMA_API_KEY=...
    uv run main.py --languages \
        --task "Simulate two ComputerCraft computers exchanging a rednet message."
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv
from ollama import Client

# Load OLLAMA_API_KEY (and friends) from a local .env if present. A real env var
# still wins — load_dotenv() does not override an already-set variable.
load_dotenv(Path(__file__).with_name(".env"))


SYSTEM = (
    "You operate through the provided tools. You may have access to MULTIPLE "
    "tool servers, and their tool names are prefixed with the server they belong "
    "to (e.g. 'files__read', 'languages__run_js'). Pick whichever tool fits. "
    "Inspect state first, then take ONE action at a time and observe the result "
    "before the next. When the task is fully complete, reply with a final message "
    "and no tool call."
)

DEFAULT_HOST = "https://ollama.com"
DEFAULT_MODEL = "glm-5.2"

HERE = Path(__file__).resolve().parent
LANG_DIR = HERE / "languages"
SKILLS_DIR = LANG_DIR / "skills"
BOOTSTRAP = LANG_DIR / "bootstrap.js"          # host-side source (seeded into the sandbox)
LAUNCH_SCRIPT = HERE / "run-languages-mcp.sh"

# In-sandbox paths. The languages server runs WITHOUT --fs-passthrough (fully
# isolated), so the sandbox cannot read the host disk. The harness seeds these
# into the persistent per-session /work (see seed_languages / new_work_session).
WORK_BOOTSTRAP = "/work/bootstrap.js"
WORK_SKILLS = "/work/skills"


# Console helpers


def step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def info(msg: str) -> None:
    print(f"    {msg}", flush=True)


def die(msg: str) -> None:
    sys.exit(f"\nERROR: {msg}")


# MCP (Streamable HTTP)  multi-server


@dataclasses.dataclass(frozen=True)
class McpServerSpec:
    """One MCP server: a short ``label`` and its Streamable HTTP ``url``."""

    label: str
    url: str


def _sse_json(resp: httpx.Response) -> dict:
    """Streamable HTTP replies are SSE ('event: message\\ndata: {...}'); the JSON
    is on a data: line. The stream can carry empty-data keepalive/ping frames
    before the real payload, so scan every data: line and return the last one
    that parses as JSON. Fall back to the raw body for plain JSON."""
    payloads = [ln[5:].strip() for ln in resp.text.splitlines() if ln.startswith("data:")]
    for data in reversed(payloads):
        if data:
            try:
                return json.loads(data)
            except json.JSONDecodeError:
                continue
    return json.loads(resp.text)


@dataclasses.dataclass
class McpConn:
    """A live MCP session against one server.

    ``work_session`` is mcp-v8's ``X-MCP-Session-Id`` — the key it uses for the
    persistent per-session ``/work`` filesystem (see the run_js tool docs). It is
    SEPARATE from the MCP-standard ``Mcp-Session-Id`` the server issues at
    initialize. Setting a stable ``X-MCP-Session-Id`` on every request is what
    makes ``/work`` persist across run_js calls (with ``fs`` omitted) — no
    snapshot labels or CA-id bookkeeping needed."""

    spec: McpServerSpec
    session_id: str | None
    tools: list[dict]                 # this server's raw tools/list
    work_session: str | None = None   # X-MCP-Session-Id (persistent /work key)

    @property
    def url(self) -> str:
        return self.spec.url

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        if self.work_session:
            h["X-MCP-Session-Id"] = self.work_session
        return h


def mcp_open(http: httpx.Client, spec: McpServerSpec, work_session: str | None = None) -> McpConn:
    """initialize -> notifications/initialized -> tools/list for one server.

    Pass ``work_session`` (an X-MCP-Session-Id) to bind a persistent /work; it is
    sent on every request, including initialize where mcp-v8 records it."""
    url = spec.url
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if work_session:
        headers["X-MCP-Session-Id"] = work_session
    init = http.post(url, headers=headers, timeout=30.0, json={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "mini-mcp-agent", "version": "0.1.0"}}})
    init.raise_for_status()
    sid = init.headers.get("mcp-session-id")
    if sid:
        headers["Mcp-Session-Id"] = sid
    http.post(url, headers=headers, timeout=30.0, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    r = http.post(url, headers=headers, timeout=30.0, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    r.raise_for_status()
    tools = _sse_json(r).get("result", {}).get("tools", [])
    return McpConn(spec=spec, session_id=sid, tools=tools, work_session=work_session)


# Tools whose result is itself an execution handle we should NOT auto-resolve.
_ASYNC_TOOLS = {"get_execution", "get_execution_output", "cancel_execution", "list_executions"}
_TERMINAL_STATES = {"completed", "succeeded", "success", "failed", "error", "cancelled", "canceled", "timeout"}


def _reconnect(http: httpx.Client, conn: McpConn) -> None:
    """Re-establish the MCP session (Mcp-Session-Id) after it drops — e.g. mcp-v8
    closes an idle session during a long LLM turn. Reuses the SAME
    X-MCP-Session-Id, so the persistent /work (and everything written to it) is
    preserved across the reconnect."""
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if conn.work_session:
        headers["X-MCP-Session-Id"] = conn.work_session
    init = http.post(conn.url, headers=headers, timeout=30.0, json={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "mini-mcp-agent", "version": "0.1.0"}}})
    init.raise_for_status()
    conn.session_id = init.headers.get("mcp-session-id")
    http.post(conn.url, headers=conn._headers(), timeout=30.0,
              json={"jsonrpc": "2.0", "method": "notifications/initialized"})


def _raw_call(http: httpx.Client, conn: McpConn, name: str, arguments: dict) -> str:
    """One tools/call -> flattened text. Transparently re-establishes the session
    and retries once on a 404 (dropped/expired MCP session). Raises otherwise."""
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": name, "arguments": arguments}}
    r = http.post(conn.url, headers=conn._headers(), timeout=600.0, json=payload)
    if r.status_code == 404:
        _reconnect(http, conn)
        r = http.post(conn.url, headers=conn._headers(), timeout=600.0, json=payload)
    r.raise_for_status()
    result = _sse_json(r).get("result", {})
    parts = []
    for block in result.get("content", []):
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif block.get("type") == "image":
            parts.append(f"[image returned: {block.get('mimeType', 'image/png')}]")
        else:
            parts.append(json.dumps(block))
    text = "\n".join(parts) or "(no output)"
    if result.get("isError"):
        text = f"ERROR: {text}"
    return text


def _maybe_execution_id(text: str) -> str | None:
    """If `text` is JSON that is just an async execution handle, return its id."""
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(obj, dict) and "execution_id" in obj and "data" not in obj and "status" not in obj:
        return obj["execution_id"]
    return None


def _poll_execution(http: httpx.Client, conn: McpConn, eid: str, timeout: float = 300.0) -> str:
    """Poll get_execution_output until the execution reaches a terminal state,
    paginating to collect the full console output. Makes mcp-v8's async run_js
    look synchronous to the agent."""
    deadline = time.monotonic() + timeout
    while True:
        chunks: list[str] = []
        offset, status = 0, None
        while True:
            raw = _raw_call(http, conn, "get_execution_output",
                            {"execution_id": eid, "byte_offset": offset, "byte_limit": 65536})
            try:
                j = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return raw
            chunks.append(j.get("data", "") or "")
            status = j.get("status")
            if j.get("has_more") and j.get("next_byte_offset", offset) > offset:
                offset = j["next_byte_offset"]
                continue
            break
        if status in _TERMINAL_STATES:
            out = "".join(chunks)
            if status not in ("completed", "succeeded", "success"):
                out = f"[execution {status}]\n{out}"
            return out or "(no output)"
        if time.monotonic() > deadline:
            return f"[execution still {status} after {timeout:.0f}s]\n" + "".join(chunks)
        time.sleep(0.4)


def mcp_call(http: httpx.Client, conn: McpConn, name: str, arguments: dict) -> str:
    """Dispatch one tools/call and return the result as plain text (naive: image
    blocks are noted, not rendered). Transparently resolves async execution
    handles (e.g. mcp-v8 run_js returns {execution_id}) by polling to
    completion, so the agent sees the output directly. Raises on transport
    error."""
    text = _raw_call(http, conn, name, arguments)
    if name not in _ASYNC_TOOLS:
        eid = _maybe_execution_id(text)
        if eid is not None:
            return _poll_execution(http, conn, eid)
    return text


# Persistent /work via the X-MCP-Session-Id header


def new_work_session() -> str:
    """A fresh per-run X-MCP-Session-Id. Fresh each run so it never resolves to a
    stale head in mcp-v8's shared session store (labels/heads persist across
    server restarts, blobs live in --fs-dir)."""
    return f"ccsa-{uuid.uuid4().hex[:12]}"


def seed_languages(http: httpx.Client, conn: McpConn, *, with_skills: bool = False) -> None:
    """Seed the engine bootstrap (and optionally the skills tree) into /work.

    Persistence is automatic: because ``conn`` carries a stable X-MCP-Session-Id,
    mcp-v8 keeps /work for that session across every run_js call (fs omitted). No
    snapshot labels or CA-id tracking — just write the files once."""
    files = {WORK_BOOTSTRAP: BOOTSTRAP.read_text(encoding="utf-8")}
    if with_skills and SKILLS_DIR.is_dir():
        for f in SKILLS_DIR.rglob("*"):
            if f.is_file():
                rel = f.relative_to(SKILLS_DIR).as_posix()
                files[f"{WORK_SKILLS}/{rel}"] = f.read_text(encoding="utf-8", errors="replace")
    info(f"seeding {len(files)} file(s) into /work (bootstrap{'+skills' if with_skills else ''})")
    parts = []
    for path, content in files.items():
        parent = path.rsplit("/", 1)[0]
        if parent and parent != "/work":
            parts.append(f"await fs.mkdir({json.dumps(parent)}, {{recursive:true}}).catch(()=>{{}});")
        parts.append(f"await fs.writeFile({json.dumps(path)}, {json.dumps(content)});")
    parts.append(f"console.log('seeded ' + {json.dumps(len(files))} + ' file(s)');")
    mcp_call(http, conn, "run_js", {"code": "\n".join(parts)})


# Tool registry (MCP tools -> Ollama/OpenAI function-tool format)


def _sanitize(label: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "-", label)


def build_tool_registry(conns: list[McpConn]) -> tuple[list[dict], dict[str, tuple[McpConn, str]]]:
    """Union every server's tools into one tool list, namespacing names as
    ``<server>__<tool>`` so servers can share tool names. Returns (tools,
    registry) where registry maps the namespaced name back to (connection,
    original tool name) for dispatch."""
    tools: list[dict] = []
    registry: dict[str, tuple[McpConn, str]] = {}
    for conn in conns:
        prefix = _sanitize(conn.spec.label)
        for t in conn.tools:
            orig = t["name"]
            name = f"{prefix}__{orig}"
            while name in registry:
                name = f"{name}_{len(registry)}"
            registry[name] = (conn, orig)
            schema = t.get("inputSchema") or {"type": "object", "properties": {}}
            tools.append({"type": "function", "function": {
                "name": name,
                "description": f"[{conn.spec.label}] " + " ".join((t.get("description") or "").split()),
                "parameters": schema}})
    return tools, registry


# Skills — inline every SKILL.md into the system prompt; the rest stays fs-readable


@dataclasses.dataclass
class Skill:
    name: str          # e.g. "craftos-sim" or "superpowers/brainstorming"
    dir: Path          # absolute skill directory (readable via the MCP fs)
    text: str          # full SKILL.md contents


def load_skills(skills_dir: Path) -> list[Skill]:
    """Find every SKILL.md under skills_dir (recursively) and read it."""
    skills: list[Skill] = []
    if not skills_dir.is_dir():
        return skills
    for md in sorted(skills_dir.rglob("SKILL.md")):
        rel = md.parent.relative_to(skills_dir).as_posix()
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        skills.append(Skill(name=rel, dir=md.parent, text=text))
    return skills


def languages_system_prompt(skills: list[Skill]) -> str:
    """The languages addendum: how to load the engines, plus every SKILL.md
    inlined and a pointer to read the rest of each skill off the MCP fs."""
    parts = [
        "\n\n=== languages sandbox (run_js) ===\n"
        "The 'languages' MCP server's run_js tool evaluates JavaScript in a FRESH "
        "V8 isolate each call. The /work filesystem PERSISTS across run_js calls "
        "(fs.readFile/readdir/writeFile). It is FULLY ISOLATED — /work is all you "
        "can touch; there is no access to the real host disk. It has the bundled "
        "WASM engines picat and craftos (CC:Tweaked sim), each also a "
        "'runjs__wasm__<name>' tool whose description carries its call signature.\n"
        "OUTPUT: run_js returns ONLY what you console.log(...) — a bare return is "
        "discarded. There is no require(); fs and the engine helpers are global. "
        "The run_js result you receive is already the finished console output — do "
        "NOT call get_execution/get_execution_output/fs_* yourself.\n"
        "CRITICAL: load the bootstrap AND call the engine in the SAME run_js block, "
        "as ONE call, e.g.:\n"
        f"  (0,eval)(await fs.readFile('{WORK_BOOTSTRAP}','utf8'));\n"
        "  const out = await craftos({nodes:[{label:'c1', collect:true, "
        "program:\"emit('hello') emit(2+3) done()\"}]});\n"
        "  console.log(JSON.stringify(out));\n"
        "Engines: await picat(code, args?) -> {stdout,stderr,exitCode}; "
        "await craftos({nodes:[{program,label?,collect?,position?,world?}]}) — a "
        "node's `output` is ONLY what its Lua passes to emit(...) (print() is not "
        "captured); end multi-line programs with done().\n"
    ]
    parts.append(
        f"IMPORTANT PATHS (in-sandbox): the bootstrap is {WORK_BOOTSTRAP} and skills "
        f"are under {WORK_SKILLS}. The skill texts below may mention container paths "
        f"like /opt/languages/... — IGNORE those and use the /work paths instead.\n"
    )
    if skills:
        parts.append(
            f"\n=== SKILLS ===\n"
            f"The full SKILL.md of every bundled skill is inlined below. The REST of "
            f"each skill (references/, scripts/, assets/) is on the run_js filesystem "
            f"under {WORK_SKILLS}/<name>/ — read it on demand with run_js: "
            f"console.log(await fs.readFile('<path>','utf8')) or fs.readdir('<dir>'). "
            f"Consult the relevant skill BEFORE related work.\n"
        )
        for s in skills:
            parts.append(
                f"\n----- SKILL: {s.name}  (dir: {WORK_SKILLS}/{s.name}) -----\n{s.text.strip()}\n"
            )
    return "".join(parts)


# The agent loop (naive multi-MCP mini-swe-agent)


def run_agent(http: httpx.Client, conns: list[McpConn], client: Client, *,
              task: str, model: str, max_steps: int, system: str) -> str:
    tools, registry = build_tool_registry(conns)
    info(f"action space: {len(tools)} tools across {len(conns)} MCP server(s)")
    for conn in conns:
        names = ", ".join(sorted(t["name"] for t in conn.tools)) or "(none)"
        info(f"  {conn.spec.label}: {names}")

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": task},
    ]
    for n in range(1, max_steps + 1):
        resp = client.chat(model=model, messages=messages, tools=tools)
        msg = resp["message"]
        messages.append(msg)
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            step(f"agent finished after {n - 1} action(s)")
            final = (msg.get("content") or "").strip()
            print(final or "(no final message)", flush=True)
            return final or "done"

        for tc in tool_calls:
            fn = tc["function"]
            name = fn["name"]
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            entry = registry.get(name)
            if entry is None:
                messages.append({"role": "tool", "tool_name": name, "content": f"unknown tool {name!r}"})
                continue
            conn, orig = entry
            info(f"[step {n}] {conn.spec.label} -> {orig}({json.dumps(args)[:120]})")
            try:
                out = mcp_call(http, conn, orig, args)
            except httpx.HTTPError as e:
                out = f"tool transport error: {type(e).__name__}: {e}"
            messages.append({"role": "tool", "tool_name": name, "content": out})
    return "max_steps_exceeded"


# Launch the bundled languages mcp-v8 server and wait for it


def launch_languages_server(port: int) -> subprocess.Popen:
    """Spawn run-languages-mcp.sh; return the Popen. Killed by the caller."""
    if not LAUNCH_SCRIPT.is_file():
        die(f"launcher not found: {LAUNCH_SCRIPT}")
    step(f"Launching languages mcp-v8 server ({LAUNCH_SCRIPT.name} --port {port})")
    return subprocess.Popen(
        ["bash", str(LAUNCH_SCRIPT), "--port", str(port)],
        cwd=str(HERE),
    )


def wait_mcp_ready(http: httpx.Client, url: str, proc: subprocess.Popen, timeout: float) -> None:
    """Poll `url` with an MCP initialize until it answers (or the process dies)."""
    deadline = time.monotonic() + timeout
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "probe", "version": "0.1.0"}}}
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    while True:
        if proc.poll() is not None:
            die(f"languages server exited early (code {proc.returncode})")
        try:
            r = http.post(url, headers=headers, json=body, timeout=5.0)
            # Require a real MCP initialize reply, not just any non-5xx (a
            # foreign service squatting the port would 404/302 and fool us).
            if r.status_code == 200 and "jsonrpc" in r.text:
                info(f"languages server ready ({url})")
                return
        except httpx.HTTPError:
            pass
        if time.monotonic() > deadline:
            die(f"timed out after {timeout:.0f}s waiting for {url}")
        time.sleep(1.0)


# Main


def parse_server(raw: str) -> McpServerSpec:
    """Parse a ``LABEL=URL`` --server argument."""
    if "=" not in raw:
        die(f"--server must be LABEL=URL (got {raw!r})")
    label, url = raw.split("=", 1)
    label, url = label.strip(), url.strip()
    if not label or not url:
        die(f"--server must be LABEL=URL (got {raw!r})")
    return McpServerSpec(label=label, url=url)


def main() -> None:
    p = argparse.ArgumentParser(
        description="Run a naive multi-MCP mini-swe-agent driven by Ollama Cloud.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--server", action="append", default=[], metavar="LABEL=URL",
                   help="an MCP Streamable HTTP endpoint as LABEL=URL (repeatable)")
    p.add_argument("--languages", action="store_true",
                   help="launch and connect the bundled languages mcp-v8 server "
                        "(picat + craftos), inline every skill's SKILL.md into the "
                        "system prompt, and expose the rest of each skill on its fs")
    p.add_argument("--languages-port", type=int, default=int(os.environ.get("MCP_V8_PORT", "8765")),
                   help="HTTP port for the launched languages server")
    p.add_argument("--task", required=True, help="the task prompt for the agent")
    p.add_argument("--model", default=os.environ.get("OLLAMA_MODEL", DEFAULT_MODEL),
                   help="Ollama cloud model id (OLLAMA_MODEL overrides the default)")
    p.add_argument("--host", default=os.environ.get("OLLAMA_HOST", DEFAULT_HOST),
                   help="Ollama host (OLLAMA_HOST overrides; default is Ollama Cloud)")
    p.add_argument("--max-steps", type=int, default=40, help="agent step budget")
    args = p.parse_args()

    specs = [parse_server(s) for s in args.server]
    if not specs and not args.languages:
        die("pass --languages and/or at least one --server LABEL=URL")

    api_key = os.environ.get("OLLAMA_API_KEY")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    if not api_key and args.host.rstrip("/") == DEFAULT_HOST:
        die("set OLLAMA_API_KEY for Ollama Cloud (get one at https://ollama.com/settings/keys)")
    client = Client(host=args.host, headers=headers)
    info(f"Ollama client ready (host {args.host}, model {args.model})")

    # System prompt: base + (on --languages) the engine addendum and every SKILL.md.
    system = SYSTEM
    skills: list[Skill] = []
    if args.languages:
        skills = load_skills(SKILLS_DIR)
        info(f"loaded {len(skills)} skill(s) from {SKILLS_DIR} into the system prompt")
        system += languages_system_prompt(skills)

    proc: subprocess.Popen | None = None
    try:
        with httpx.Client() as http:
            if args.languages:
                proc = launch_languages_server(args.languages_port)
                lang_url = f"http://127.0.0.1:{args.languages_port}/mcp"
                wait_mcp_ready(http, lang_url, proc, timeout=180.0)
                specs = [McpServerSpec(label="languages", url=lang_url)] + specs

            conns: list[McpConn] = []
            for spec in specs:
                step(f"Opening MCP session: {spec.label} at {spec.url}")
                # The languages server gets a persistent /work via X-MCP-Session-Id.
                work_session = new_work_session() if (args.languages and spec.label == "languages") else None
                try:
                    conn = mcp_open(http, spec, work_session=work_session)
                except Exception as e:
                    info(f"could not connect to {spec.label}: {type(e).__name__}: {e} — skipping (best effort)")
                    continue
                info(f"session {conn.session_id or '(stateless)'} — {len(conn.tools)} tool(s)")
                conns.append(conn)
                if work_session:
                    seed_languages(http, conn, with_skills=True)

            if not conns:
                die("no MCP servers connected — cannot run the agent")

            step(f"Running mini-swe-agent (ollama {args.model}) against {len(conns)} MCP server(s)")
            info(f"task: {args.task}")
            result = run_agent(http, conns, client, task=args.task, model=args.model,
                               max_steps=args.max_steps, system=system)
            step(f"Agent result: {result[:200]}")
    finally:
        if proc is not None and proc.poll() is None:
            step("Stopping languages mcp-v8 server")
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()
