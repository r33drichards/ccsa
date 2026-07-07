#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["ollama", "httpx", "pyyaml", "python-dotenv"]
# ///
"""Spike bridge: run a craftgen sim spec against the self-hosted mcp-v8 languages
server via run_js, and emit a metric = number of sim postconditions PASSED.

This is what pi-autoresearch's .auto/measure.sh calls. It exercises the exact
"pi tool" path (run_js over the local languages server) that the pi sub-agent
would use — here driven from Python so the loop is runnable before pi is on the
box. Program(s) under optimization live as ordinary host files next to the spec
(so pi-autoresearch can commit/revert them); we ship them into the sandbox /work
for each measurement.

Usage:
  run_sim.py --port 8791 --spec spec.yaml
Stdout: the bare metric integer (passed count) on the last line — the value
pi-autoresearch maximizes. Diagnostics (failing assertions) go to stderr.
"""
import argparse
import re
import sys
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]  # spike/melon-loop/bin -> repo root
sys.path.insert(0, str(REPO))

from main import McpServerSpec, mcp_open, mcp_call, seed_languages, new_work_session  # noqa: E402
from craftgen import load_spec, validate  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--spec", default="spec.yaml")
    args = ap.parse_args()

    spec_path = Path(args.spec).resolve()
    spec = load_spec(spec_path)
    url = f"http://127.0.0.1:{args.port}/mcp"

    with httpx.Client(timeout=120) as http:
        conn = mcp_open(http, McpServerSpec(label="languages", url=url),
                        work_session=new_work_session())
        seed_languages(http, conn, with_skills=False)
        # ship each program (a host file next to the spec) into the sandbox /work
        for p in spec.programs:
            src = (spec_path.parent / p.name).read_text()
            mcp_call(http, conn, "run_js", {
                "code": f"await fs.writeFile({p.path!r}, {src!r});"
            })
        res = validate(http, conn, spec)

    out = res.sim_output or res.feedback or ""
    passed = len(re.findall(r"^\s*ok\s+-", out, re.M))
    fails = re.findall(r"^\s*FAIL\s+-.*$", out, re.M)

    # diagnostics -> stderr (the agent reads these to decide the next edit)
    print(f"[run_sim] complete={res.complete} passed={passed} "
          f"failed={len(fails)}", file=sys.stderr)
    for f in fails:
        print(f"  {f.strip()}", file=sys.stderr)
    if not out.strip():
        print("[run_sim] (no sim output — program likely errored at runtime)",
              file=sys.stderr)

    # the metric pi-autoresearch maximizes: bare integer on the last stdout line
    print(passed)


if __name__ == "__main__":
    main()
