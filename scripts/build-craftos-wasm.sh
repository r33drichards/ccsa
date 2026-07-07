#!/usr/bin/env bash
# Reproducibly build craftos.{js,wasm} from source (sim/craftos2) and install into
# languages/, then rebuild bootstrap.js. This replaces the historical ad-hoc build.
#
#   ./scripts/build-craftos-wasm.sh
#
# nix pins the whole toolchain: emscripten + make, the Poco/OpenSSL/zlib/pcre2/expat
# HEADERS (compile-time only — the headless path carries no Poco runtime dep), and
# the exact craftos2-lua + craftos2-rom commits. We run under `nix shell` (not a
# sandboxed derivation) so emscripten can build its SDL2 port on first run — a pure
# sandbox blocks that one-time fetch.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> resolving pinned deps via nix"
fetchgit() { nix eval --raw --impure --expr "builtins.fetchGit { url = \"$1\"; rev = \"$2\"; allRefs = true; }"; }
LUA=$(fetchgit https://github.com/MCJack123/craftos2-lua.git d394c303f76103d2251d73b6d5d1ff01877a244f)
ROM=$(fetchgit https://github.com/MCJack123/craftos2-rom.git e6f63a1b168a4e37c5b06b090003219085f638cf)
inc() { echo "$(nix build --no-link --print-out-paths "nixpkgs#$1.dev")/include"; }
POCO=$(inc poco); OPENSSL=$(inc openssl); ZLIB=$(inc zlib); PCRE2=$(inc pcre2); EXPAT=$(inc expat)

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
cp -R sim/craftos2/. "$BUILD/"
rm -rf "$BUILD/craftos2-lua"; cp -R "$LUA" "$BUILD/craftos2-lua"; chmod -R +w "$BUILD/craftos2-lua"

echo "==> building craftos.wasm (emscripten 5.0.7; first run builds the SDL2 port + sysroot cache)"
# emscripten 5.0.7 specifically (the version sim/craftos2's wasm path was developed
# against; registry nixpkgs may pin an older emcc that errors on Computer.cpp). curl
# is needed for emscripten's one-time port fetch.
nix shell github:NixOS/nixpkgs/nixos-unstable#emscripten nixpkgs#gnumake nixpkgs#curl -c bash -c "
  set -euo pipefail; cd '$BUILD'
  export EM_CACHE='$BUILD/.emcache'; mkdir -p \"\$EM_CACHE\"
  export CRAFTOS_ROM='$ROM' POCO_INC='$POCO'
  export EXTRA_CPPFLAGS='-I$OPENSSL -I$ZLIB -I$PCRE2 -I$EXPAT'
  bash embed/build-wasm.sh
"
echo "==> install -> languages/engines + languages/vendor, rebuild bootstrap.js"
cp "$BUILD/craftos.js"   languages/engines/craftos.js
cp "$BUILD/craftos.wasm" languages/engines/craftos.wasm
cp "$BUILD/craftos.js"   languages/vendor/craftos.js
node languages/build-bootstrap.mjs
echo "done."
