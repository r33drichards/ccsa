#!/usr/bin/env bash
# Launch the "languages" mcp-v8 server — the run_js MCP server with the picat
# and craftos (CC:Tweaked) WASM engines — over Streamable HTTP at /mcp.
#
# This is the MCP server the mini agent (main.py --languages) connects to. It
# exposes:
#   * run_js                — evaluate JS in a fresh V8 isolate (fs + engines)
#   * runjs__wasm__picat    — stub advertising the picat() helper
#   * runjs__wasm__craftos  — stub advertising the craftos() sim helper
#
# The engines' JS glue is seeded into /work/bootstrap.js by the harness (main.py
# / craftgen.py), which then loads it in a single run_js call:
#   (0,eval)(await fs.readFile('/work/bootstrap.js','utf8'));
#   console.log(JSON.stringify(await craftos({nodes:[{label:'c1',collect:true,
#     program:"emit('hi') emit(2+3) done()"}]})));
#
# Filesystem policy: FULLY ISOLATED — run_js fs ops operate on the virtual,
# content-addressed sandbox filesystem (NO --fs-passthrough, so the sandbox
# cannot read or write the real host disk). Because there is no host passthrough,
# every path the policy sees is already confined to the isolated store, so the
# rego only needs to refuse ".." traversal — it allows any other path whether it
# is written absolute (/work/...), relative (work/..., bootstrap.js, .), or points
# at some other in-sandbox exploration path. The harness seeds /work/bootstrap.js
# + skills and threads the CA snapshot across calls so /work persists like a
# normal dir. The wasm engines load from real paths via --wasm-module (the server
# process at startup, not run_js fs).
#
# Env / flags:
#   --port N        HTTP port (default 8080; env MCP_V8_PORT)
#   --work DIR      dir for the CA snapshot blob store (default ./.mcp-work)
#   MCP_V8_BIN      path to the mcp-v8 `server` binary; else `nix run .#mcp-v8`
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANG_DIR="$HERE/languages"
PORT="${MCP_V8_PORT:-8080}"
WORK_DIR="$HERE/.mcp-work"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --work) WORK_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$WORK_DIR"
WORK_DIR="$(cd "$WORK_DIR" && pwd)"

# Build bootstrap.js if missing (bundles the engine JS glue; wasm loads via
# --wasm-module below).
if [ ! -s "$LANG_DIR/bootstrap.js" ]; then
  echo "==> building bootstrap.js" >&2
  ( cd "$LANG_DIR" && node build-bootstrap.mjs )
fi

# Resolve the mcp-v8 binary: explicit env, the vendored prebuilt binary
# (bin/mcp-v8, fetched from the mcp-js GitHub release — see fetch-mcp-v8.sh),
# PATH, or finally build it via nix.
if [ -n "${MCP_V8_BIN:-}" ]; then
  MCP=( "$MCP_V8_BIN" )
elif [ -x "$HERE/bin/mcp-v8" ]; then
  MCP=( "$HERE/bin/mcp-v8" )
elif command -v mcp-v8 >/dev/null 2>&1; then
  MCP=( mcp-v8 )
elif command -v server >/dev/null 2>&1; then
  MCP=( server )
else
  echo "==> mcp-v8 not found; fetching the prebuilt binary" >&2
  "$HERE/fetch-mcp-v8.sh"
  MCP=( "$HERE/bin/mcp-v8" )
fi

# Per-run policy dir. The filesystem rego allows any non-".." path within the
# isolated virtual fs (no --fs-passthrough, so nothing can escape it); the fetch
# rego denies network.
RUN_DIR="$WORK_DIR/.policies"
mkdir -p "$RUN_DIR"

cat > "$RUN_DIR/filesystem.rego" <<'EOF'
package mcp.filesystem

# Fully isolated: run_js fs ops act on the virtual, content-addressed sandbox
# filesystem — NO --fs-passthrough, so no path can reach the real host disk. That
# is the whole safety argument: since there is no passthrough, broadening this
# policy cannot expose the host; every path is already trapped inside the isolated
# store. So we allow ANY path — absolute (/work/...), relative (work/...,
# bootstrap.js, .), or any other in-sandbox exploration path — and only refuse
# ".." traversal (paths reach the policy unnormalized, so a substring check is the
# right guard). This lets the agent's legitimate exploration succeed regardless of
# how it happens to spell a path, instead of failing everything that is not
# spelled "/work…". The harness seeds /work/bootstrap.js + skills and threads the
# CA snapshot across calls so /work persists like a normal dir; the wasm engines
# load from real paths via --wasm-module (the server process at startup, not
# subject to this run_js fs policy).
default allow = false

allow if {
    not contains(input.path, "..")
}
EOF

# Engines don't need network; deny fetch by default.
cat > "$RUN_DIR/fetch.rego" <<'EOF'
package mcp.fetch
default allow = false
EOF

cat > "$RUN_DIR/policies.json" <<EOF
{
  "fetch": {
    "mode": "all",
    "policies": [
      { "url": "file://$RUN_DIR/fetch.rego", "rule": "data.mcp.fetch.allow" }
    ]
  },
  "filesystem": {
    "mode": "all",
    "policies": [
      { "url": "file://$RUN_DIR/filesystem.rego", "rule": "data.mcp.filesystem.allow" }
    ]
  }
}
EOF

PICAT_DESC="Picat logic/constraint language. In ONE run_js call, first (0,eval) bootstrap.js then await picat(code, args?) -> {stdout, stderr, exitCode}."
CRAFTOS_DESC="ComputerCraft/CC:Tweaked emulator (networked computers + turtles). In ONE run_js call, first (0,eval) bootstrap.js then await craftos({timeout_ms?, nodes:[{program, label?, collect?:true, position?, world?}]}) -> {net, nodes:[{label, id, output, turtle}]}. A node's output is only what its program passes to emit(...); print() is NOT captured; call done() to finish. See the craftos-sim skill for the full node/turtle/GPS API."

echo "==> languages mcp-v8 on http://127.0.0.1:$PORT/mcp" >&2
echo "    LANG_DIR=$LANG_DIR" >&2
echo "    WORK_DIR=$WORK_DIR" >&2

exec "${MCP[@]}" \
  --http-port "$PORT" \
  --bind-host 127.0.0.1 \
  --policies-json "$RUN_DIR/policies.json" \
  --heap-memory-max 256 \
  --fs-store dir \
  --fs-dir "$WORK_DIR/fs" \
  --wasm-module "picat=$LANG_DIR/engines/picat.wasm:512m" \
  --wasm-stub-description "picat=$PICAT_DESC" \
  --wasm-module "craftos=$LANG_DIR/engines/craftos.wasm:512m" \
  --wasm-stub-description "craftos=$CRAFTOS_DESC"
