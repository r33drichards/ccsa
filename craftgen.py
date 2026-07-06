#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "ollama",
#     "httpx",
#     "pyyaml",
# ]
# ///
"""craftgen — generate a CC:Tweaked program that passes a declarative sim test.

The validator-in-the-loop pattern (https://robertwendt — "Simple Control Flow
for Automatically Steering Agents"): the agent doesn't get to *declare* success.
After every turn a DETERMINISTIC validator runs the CraftOS sim itself and gates
completion on `SIM_RESULT: PASS`. The loop only breaks when the real world state
matches the postcondition — or the step budget runs out.

You declare, in one spec file:
  * a **CraftOS sim** (nodes, world / world gen, and a `world.test(sim)`
    postcondition — see the craftos-sim skill);
  * where the agent's program(s) live, via a lightweight read-path sigil
    `program: "@file:turtle.lua"` in a node.

The agent writes each `@file:NAME` program into the isolated sandbox filesystem
at `/work/NAME` (`run_js` -> `fs.writeFile`). The validator reads them back and
runs the sim. Multiple `@file:` nodes = multiple programs the agent controls.

The sandbox runs WITHOUT --fs-passthrough: it is fully isolated (no host-disk
access). /work persists across run_js calls because the connection carries a
stable X-MCP-Session-Id (mcp-v8's persistent per-session filesystem key).

Business logic is `run_taskspec(...)` — pure, no argv/printing coupling — so a
webhook handler can call it the same way this CLI does. For testing: the CLI.

    export OLLAMA_API_KEY=...
    uv run craftgen.py examples/mine-forward.yaml
    uv run craftgen.py examples/tunnel.yaml --model glm-5.2 --max-steps 12
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import yaml
from ollama import Client

# Reuse the MCP + agent core from the mini agent (same directory).
import main as mini
from main import (
    DEFAULT_HOST,
    DEFAULT_MODEL,
    McpConn,
    McpServerSpec,
    SKILLS_DIR,
    WORK_BOOTSTRAP,
    WORK_SKILLS,
    die,
    info,
    launch_languages_server,
    load_skills,
    mcp_call,
    mcp_open,
    new_work_session,
    seed_languages,
    step,
    wait_mcp_ready,
)

# The agent writes programs here (in the isolated sandbox /work).
WORK = "/work"

# Skills inlined into the agent's system prompt (the ones about writing CC/turtle
# Lua and running the sim). The rest of each skill stays fs-readable under /work.
FOCUS_SKILLS = ("craftos-sim", "cc-tweaked", "picat")

FILE_SIGIL = re.compile(r"^@file:(.+)$")


# ── Spec model ───────────────────────────────────────────────────────────────


@dataclass
class ProgramRef:
    """One `@file:NAME` program the agent must author, at /work/NAME."""

    name: str          # NAME as written in the spec
    path: str          # in-sandbox path: /work/NAME
    node_index: int    # which sim node loads it
    node_label: str


@dataclass
class TaskSpec:
    task: str
    sim: dict                       # the craftos() spec (programs resolved at validate time)
    programs: list[ProgramRef]
    raw: dict = field(default_factory=dict)


def load_spec(path_or_obj: str | Path | dict) -> TaskSpec:
    """Parse a YAML/JSON spec file (or an already-parsed dict) into a TaskSpec."""
    if isinstance(path_or_obj, dict):
        raw = path_or_obj
    else:
        raw = yaml.safe_load(Path(path_or_obj).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        die("spec must be a YAML/JSON mapping")
    task = raw.get("task")
    sim = raw.get("sim")
    if not isinstance(task, str) or not task.strip():
        die("spec.task must be a non-empty string")
    if not isinstance(sim, dict) or not isinstance(sim.get("nodes"), list) or not sim["nodes"]:
        die("spec.sim must have a non-empty nodes list")

    programs: list[ProgramRef] = []
    seen: set[str] = set()
    for i, node in enumerate(sim["nodes"]):
        if not isinstance(node, dict):
            die(f"spec.sim.nodes[{i}] must be a mapping")
        prog = node.get("program")
        m = FILE_SIGIL.match(prog.strip()) if isinstance(prog, str) else None
        if not m:
            continue
        name = m.group(1).strip()
        if "/" in name or ".." in name:
            die(f"@file name must be a bare filename (got {name!r})")
        if name not in seen:
            seen.add(name)
            programs.append(ProgramRef(name=name, path=f"{WORK}/{name}", node_index=i,
                                       node_label=node.get("label", f"node{i}")))
    if not programs:
        die("spec.sim has no node with a program: \"@file:NAME\" — nothing for the agent to write")
    return TaskSpec(task=task.strip(), sim=sim, programs=programs, raw=raw)


# ── The deterministic validator ──────────────────────────────────────────────


@dataclass
class ValidationResult:
    complete: bool
    feedback: str          # what to show the agent (sim log or missing-file note)
    sim_output: str = ""   # raw collected node output, when the sim ran


def _validator_js(spec: TaskSpec) -> str:
    """run_js source: read each @file program off /work, run the sim, print a JSON
    verdict. Runs inside the sandbox (same per-session /work as the agent)."""
    nodes = []
    prog_files: dict[str, str] = {}
    nil_sim: dict[str, bool] = {}
    by_name = {p.name: p for p in spec.programs}
    for i, node in enumerate(spec.sim["nodes"]):
        node = dict(node)
        # `nil_sim: true` (craftgen-only, stripped before craftos sees it) runs the
        # node's program with the `sim` global nil'd — exercising the REAL-device
        # code path (sim is simulator-only). The post-condition still runs: the
        # craftos postlude reads _G.sim, which a `local sim = nil` prefix leaves
        # intact. Use it with a real input source (e.g. GPS host nodes) so a
        # program that reaches for sim.* unguarded fails the test.
        ns = bool(node.pop("nil_sim", False))
        prog = node.get("program")
        m = FILE_SIGIL.match(prog.strip()) if isinstance(prog, str) else None
        if m:
            # Resolve by @file NAME, so several nodes can share one program file
            # (e.g. idempotency: the same turtle.lua run from different starts).
            ref = by_name[m.group(1).strip()]
            node["program"] = None
            prog_files[str(i)] = ref.path
            if ns:
                nil_sim[str(i)] = True
        elif ns and isinstance(prog, str):
            node["program"] = "local sim = nil\n" + prog   # inline program
        nodes.append(node)
    top = {k: v for k, v in spec.sim.items() if k != "nodes"}
    return (
        f"(0,eval)(await fs.readFile({json.dumps(WORK_BOOTSTRAP)},'utf8'));\n"
        f"const nodes = {json.dumps(nodes)};\n"
        f"const progFiles = {json.dumps(prog_files)};\n"
        f"const nilSim = {json.dumps(nil_sim)};\n"
        "const missing = [];\n"
        "for (const k of Object.keys(progFiles)) {\n"
        "  try { let src = await fs.readFile(progFiles[k],'utf8');\n"
        "    if (nilSim[k]) src = 'local sim = nil\\n' + src;\n"
        "    nodes[k].program = src; }\n"
        "  catch (e) { missing.push(progFiles[k]); }\n"
        "}\n"
        "if (missing.length) { console.log(JSON.stringify({status:'missing', missing})); }\n"
        "else {\n"
        f"  const spec = Object.assign({json.dumps(top)}, {{nodes}});\n"
        "  const out = await craftos(spec);\n"
        "  console.log(JSON.stringify({status:'ran', nodes: out.nodes.map(n => ({label:n.label, output:n.output}))}));\n"
        "}\n"
    )


def validate(http: httpx.Client, conn: McpConn, spec: TaskSpec) -> ValidationResult:
    """Run the sim deterministically and gate on SIM_RESULT: PASS."""
    out = mcp_call(http, conn, "run_js", {"code": _validator_js(spec)})
    try:
        verdict = json.loads(out.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return ValidationResult(False, f"validator could not run the sim:\n{out[:1500]}")

    if verdict.get("status") == "missing":
        names = ", ".join(Path(m).name for m in verdict.get("missing", []))
        return ValidationResult(
            False,
            f"You have not written these program file(s) yet: {names}. Write each with "
            f"run_js: await fs.writeFile('/work/<name>', <lua source>).")

    node_outs = verdict.get("nodes", [])
    combined = "\n".join(f"[{n.get('label')}]\n{n.get('output','')}" for n in node_outs)
    has_pass = "SIM_RESULT: PASS" in combined
    has_fail = "SIM_RESULT: FAIL" in combined
    if has_pass and not has_fail:
        return ValidationResult(True, "SIM_RESULT: PASS — all postconditions met.", combined)
    reason = "postconditions FAILED" if has_fail else "no SIM_RESULT: PASS emitted"
    return ValidationResult(
        False,
        f"Validation failed ({reason}). The validator ran the sim and got:\n\n{combined}\n\n"
        f"Revise the program(s) and rewrite them so every postcondition passes.",
        combined)


# ── Agent system prompt ──────────────────────────────────────────────────────


def build_system_prompt(spec: TaskSpec) -> str:
    focus = [s for s in load_skills(SKILLS_DIR) if s.name in FOCUS_SKILLS]

    prog_lines = "\n".join(
        f"  - write node '{p.node_label}''s program to: {p.path}  (referenced as @file:{p.name})"
        for p in spec.programs)
    sim_yaml = yaml.safe_dump(spec.sim, sort_keys=False, width=100)

    parts = [
        mini.SYSTEM,
        "\n\n=== languages sandbox (run_js) ===\n"
        "The 'languages' MCP server's run_js tool evaluates JavaScript in a FRESH V8 "
        "isolate each call. The /work filesystem PERSISTS across calls and is FULLY "
        "ISOLATED (no host-disk access — /work is all you can touch). It has the picat "
        "and craftos engines. run_js returns ONLY what you console.log(...); the result "
        "is already the finished output — do NOT call get_execution/fs_* yourself.\n"
        "Load the bootstrap AND call an engine in the SAME run_js block, e.g.:\n"
        f"  (0,eval)(await fs.readFile('{WORK_BOOTSTRAP}','utf8'));\n"
        "  const out = await craftos({nodes:[{label:'c1', collect:true, world_lua:'...', program:'...'}]});\n"
        "  console.log(JSON.stringify(out));\n"
        f"IMPORTANT PATHS (in-sandbox): the bootstrap is {WORK_BOOTSTRAP} and skills are "
        f"under {WORK_SKILLS}. The reference skill texts below may mention container paths "
        f"like /opt/languages/... — IGNORE those and use the /work paths instead.\n",
        "\n=== YOUR JOB ===\n"
        f"TASK: {spec.task}\n\n"
        "Write CC:Tweaked Lua program(s) into /work so the sim's postcondition passes. "
        "Write each with run_js, e.g.:\n"
        "  await fs.writeFile('/work/turtle.lua', [[ <your lua here> ]]); console.log('wrote');\n"
        "Program file(s) to author:\n" + prog_lines + "\n\n"
        "A DETERMINISTIC VALIDATOR runs after every turn: it loads your file(s), runs the "
        "sim below, and checks for 'SIM_RESULT: PASS'. You are NOT done until it passes — "
        "declaring success without a passing validator does nothing. You SHOULD test your "
        "own program first by running the same sim via run_js + craftos(...) and inspecting "
        "the assertion log before relying on the validator.\n\n"
        "FAIL OPEN ON A NIL `sim` (CRITICAL — the program must run on the REAL target too):\n"
        "The `sim` global (sim.pos, sim.facing, sim.block, sim.chest, sim.assert*, setpos, "
        "periphemu, ...) exists ONLY inside this simulator. On the real device `sim` is NIL, "
        "and any unguarded `sim.xxx()` throws \"attempt to index a nil value ('sim')\" — the "
        "program dies on the first line. So NEVER touch `sim.*` (or other sim-only globals) "
        "unguarded. Fail open: guard every simulator-only call and provide a real fallback, "
        "e.g.\n"
        "  local x, z, facing\n"
        "  if sim then x, z, facing = sim.pos().x, sim.pos().z, sim.facing()  -- sim only\n"
        "  else <get it from the real world: gps.locate(), a peripheral, or a config const> end\n"
        "Get genuine runtime inputs (position, orientation, block data) from the ACTUAL "
        "environment (gps, turtle.inspect*, peripherals, configured constants) — treat `sim` "
        "purely as an optional convenience. The generated program MUST behave correctly when "
        "`sim == nil`.\n\n"
        "THE SIM / WORLD / POSTCONDITION (this exact spec is what the validator runs; your "
        "program is substituted for each @file node):\n```yaml\n" + sim_yaml + "```\n",
    ]
    if focus:
        parts.append(
            f"\n=== REFERENCE SKILLS ===\n"
            f"Full SKILL.md for {', '.join(s.name for s in focus)} below (turtle API, sim "
            f"assertions, engine call signatures). The rest of each skill is fs-readable "
            f"under {WORK_SKILLS}/<name>.\n")
        for s in focus:
            parts.append(f"\n----- SKILL: {s.name} -----\n{s.text.strip()}\n")
    return "".join(parts)


# ── The validator-in-the-loop agent ──────────────────────────────────────────


@dataclass
class RunResult:
    status: str                    # "pass" | "max_steps"
    steps: int
    sim_output: str
    final_message: str
    programs: dict[str, str]       # name -> source, for the passing programs


def run_taskspec(spec: TaskSpec, conn: McpConn, http: httpx.Client, client: Client, *,
                 model: str, max_steps: int) -> RunResult:
    """Core business logic: drive the agent until the sim validator passes. Pure
    of argv/exit — a webhook handler can call this directly. ``conn`` must carry a
    persistent /work (opened with an X-MCP-Session-Id) and be pre-seeded."""
    from main import build_tool_registry

    tools, registry = build_tool_registry([conn])
    system = build_system_prompt(spec)
    info(f"action space: {len(tools)} tools; validating on SIM_RESULT: PASS")

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": f"{spec.task}\n\nWrite the program file(s), test with the "
                                     f"sim, and iterate until the validator reports PASS."},
    ]
    last_sim = ""
    for n in range(1, max_steps + 1):
        resp = client.chat(model=model, messages=messages, tools=tools)
        msg = resp["message"]
        messages.append(msg)
        for tc in msg.get("tool_calls") or []:
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
            c, orig = entry
            info(f"[step {n}] {orig}({json.dumps(args)[:120]})")
            try:
                out = mcp_call(http, c, orig, args)
            except httpx.HTTPError as e:
                out = f"tool transport error: {type(e).__name__}: {e}"
            messages.append({"role": "tool", "tool_name": name, "content": out})

        # Deterministic gate — run the sim ourselves every turn.
        v = validate(http, conn, spec)
        last_sim = v.sim_output or last_sim
        info(f"[step {n}] validator: {'PASS' if v.complete else 'fail'}")
        if v.complete:
            programs = {p.name: _read_program(http, conn, p) for p in spec.programs}
            return RunResult("pass", n, v.sim_output, (msg.get("content") or "").strip(), programs)
        messages.append({"role": "user", "content": f"VALIDATOR (deterministic):\n{v.feedback}"})

    programs = {p.name: _read_program(http, conn, p) for p in spec.programs}
    return RunResult("max_steps", max_steps, last_sim, "", programs)


def _read_program(http: httpx.Client, conn: McpConn, ref: ProgramRef) -> str:
    code = f"try{{console.log(await fs.readFile({json.dumps(ref.path)},'utf8'))}}catch(e){{console.log('')}}"
    return mcp_call(http, conn, "run_js", {"code": code})


# ── CLI ──────────────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(
        description="Generate a CC:Tweaked program that passes a declarative CraftOS sim test, "
                    "using a deterministic validator-in-the-loop.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("spec", help="path to the task spec (YAML or JSON)")
    p.add_argument("--model", default=os.environ.get("OLLAMA_MODEL", DEFAULT_MODEL),
                   help="Ollama cloud model id")
    p.add_argument("--host", default=os.environ.get("OLLAMA_HOST", DEFAULT_HOST))
    p.add_argument("--max-steps", type=int, default=15, help="agent step budget")
    p.add_argument("--port", type=int, default=int(os.environ.get("MCP_V8_PORT", "8765")),
                   help="port for the launched languages mcp-v8 server")
    p.add_argument("--keep-server", action="store_true", help="leave the languages server running on exit")
    args = p.parse_args()

    spec = load_spec(args.spec)
    info(f"spec: {spec.task!r} — {len(spec.programs)} program(s) to author")

    api_key = os.environ.get("OLLAMA_API_KEY")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    if not api_key and args.host.rstrip("/") == DEFAULT_HOST:
        die("set OLLAMA_API_KEY for Ollama Cloud (https://ollama.com/settings/keys)")
    client = Client(host=args.host, headers=headers)

    proc = None
    try:
        with httpx.Client() as http:
            proc = launch_languages_server(args.port)
            url = f"http://127.0.0.1:{args.port}/mcp"
            wait_mcp_ready(http, url, proc, timeout=180.0)
            step(f"Opening MCP session: languages at {url}")
            # Persistent /work for this run, keyed by a fresh X-MCP-Session-Id.
            conn = mcp_open(http, McpServerSpec(label="languages", url=url), work_session=new_work_session())
            info(f"session {conn.session_id or '(stateless)'} — {len(conn.tools)} tool(s)")

            seed_languages(http, conn, with_skills=True)   # bootstrap + skills into /work

            step(f"Running validator-in-the-loop agent (ollama {args.model})")
            result = run_taskspec(spec, conn, http, client, model=args.model, max_steps=args.max_steps)

            step(f"RESULT: {result.status.upper()} after {result.steps} step(s)")
            if result.sim_output:
                print("\n--- final sim output ---\n" + result.sim_output, flush=True)
            for name, src in result.programs.items():
                print(f"\n--- program: {name} ---\n{src.strip() or '(empty / not written)'}", flush=True)
            sys.exit(0 if result.status == "pass" else 1)
    finally:
        if proc is not None and proc.poll() is None and not args.keep_server:
            step("Stopping languages mcp-v8 server")
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()


if __name__ == "__main__":
    main()
