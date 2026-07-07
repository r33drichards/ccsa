#!/usr/bin/env bash
# build-wasm.sh — build the single-threaded CraftOS-PC emulator + ccsim C ABI to
# WebAssembly (craftos.js + craftos.wasm), NO pthreads / SharedArrayBuffer.
#
# Mirrors embed/build.sh but targets Emscripten. The headless cc_run / GPS path
# carries no Poco dependency (ccsim.cpp uses vendored nlohmann/json); the rest of
# the emulator is compiled against Poco *headers* only (brew) and any unreferenced
# Poco runtime symbol is left undefined (ERROR_ON_UNDEFINED_SYMBOLS=0) — the
# headless path never calls into Poco at runtime.
#
# Requires emcc on PATH (brew install emscripten) and the Lua wasm static lib at
# craftos2-lua/src/liblua.a (build with: make -C craftos2-lua/src a CC=emcc ...).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="/opt/homebrew/bin:$PATH"

ROM="${CRAFTOS_ROM:-$HOME/craftos2-rom}"
POCO_INC="${POCO_INC:-/opt/homebrew/include}"
ODIR=obj-wasm
mkdir -p "$ODIR"

# Lua compiled to a wasm static lib (PUC Lua 5.2, no JIT). Build it if missing.
if [ ! -f craftos2-lua/src/liblua.a ] || ! emar t craftos2-lua/src/liblua.a >/dev/null 2>&1; then
  echo "[0/3] build Lua wasm static lib"
  make -C craftos2-lua/src clean >/dev/null 2>&1 || true
  make -C craftos2-lua/src a CC="emcc" CXX="em++" AR="emar rcu" RANLIB="emranlib" \
    SYSCFLAGS="-DLUA_USE_LINUX -fPIC -DLUA_USE_C89 -sUSE_SDL=2" >/dev/null
fi

CPPFLAGS=(
  -O2 -std=c++17 -g0
  -DNO_CLI -DNO_PNG -DNO_WEBP -DNO_MIXER -DPRINT_TYPE=1
  -I"$POCO_INC" -Icraftos2-lua/include -Iapi -Isrc
  -sUSE_SDL=2 -sDISABLE_EXCEPTION_CATCHING=0
  -Wno-implicit-const-int-float-conversion
  -Wno-deprecated-declarations -Wno-unknown-warning-option
  -Wno-unused-command-line-argument
)
CFLAGS=( -O2 -g0 -sUSE_SDL=2 -Wno-unknown-warning-option )

# Emulator C++ sources (mirrors Makefile.in _OBJ, minus main.cpp; http via the
# emscripten FETCH backend instead of the Poco::Net one).
CXX_SRCS=(
  src/Computer.cpp src/configuration.cpp src/gif.cpp src/plugin.cpp
  src/runtime.cpp src/scheduler.cpp src/termsupport.cpp src/util.cpp
  src/platform.cpp
  src/apis/config.cpp src/apis/fs.cpp src/apis/handles/fs_handle.cpp
  src/apis/http_emscripten.cpp src/apis/mounter.cpp src/apis/os.cpp
  src/apis/periphemu.cpp src/apis/peripheral.cpp src/apis/redstone.cpp
  src/apis/term.cpp
  src/mem/cluster.cpp
  src/peripheral/speaker_sounds.cpp
  src/peripheral/monitor.cpp src/peripheral/printer.cpp
  src/peripheral/computer_p.cpp src/peripheral/modem.cpp
  src/peripheral/drive.cpp src/peripheral/debugger.cpp
  src/peripheral/speaker.cpp
  src/peripheral/chest.cpp src/peripheral/energy.cpp src/peripheral/tank.cpp
  src/terminal/SDLTerminal.cpp src/terminal/HardwareSDLTerminal.cpp
  src/terminal/CLITerminal.cpp
  src/terminal/RawTerminal.cpp src/terminal/TRoRTerminal.cpp
  embed/ccsim.cpp
)
C_SRCS=( src/favicon.c src/font.c )

obj_for() { echo "$ODIR/$(echo "$1" | sed 's#/#_#g; s#\.[cp]*$#.o#')"; }

OBJS=()
echo "[1/3] compile C sources"
for s in "${C_SRCS[@]}"; do
  o=$(obj_for "$s"); OBJS+=("$o")
  if [ "$s" -nt "$o" ] || [ ! -f "$o" ]; then
    echo "  [CC]  $s"
    emcc "${CFLAGS[@]}" -c "$s" -o "$o"
  fi
done

echo "[2/3] compile C++ sources"
for s in "${CXX_SRCS[@]}"; do
  o=$(obj_for "$s"); OBJS+=("$o")
  if [ "$s" -nt "$o" ] || [ ! -f "$o" ]; then
    echo "  [CXX] $s"
    em++ "${CPPFLAGS[@]}" -c "$s" -o "$o"
  fi
done

echo "[3/3] link craftos.js + craftos.wasm"
em++ -O2 \
  "${OBJS[@]}" craftos2-lua/src/liblua.a \
  -sUSE_SDL=2 \
  -sASYNCIFY \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=134217728 \
  -sSTACK_SIZE=8388608 \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sDISABLE_EXCEPTION_CATCHING=0 \
  -sFORCE_FILESYSTEM=1 \
  -sEXIT_RUNTIME=0 \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=CraftOS \
  -sEXPORTED_FUNCTIONS=_cc_run,_cc_gps_selftest,_cc_free,_cc_gps_result,_cc_run_result,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,ccall,UTF8ToString,stringToUTF8,FS \
  --embed-file "$ROM@/craftos" \
  -o craftos.js

echo "done:"
ls -la craftos.js craftos.wasm
