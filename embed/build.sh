#!/usr/bin/env bash
# Build the embedded CraftOS-PC library + the C++ GPS proof, under the nix
# devshell (run from the repo root, inside `nix develop` or via the wrapper at
# the bottom). Produces:
#   embed/libcraftos2.a   - the whole emulator minus main(), as a static lib
#   embed/gps_test        - standalone proof: 5 networked computers resolving GPS
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

POCO_LIBS="-lPocoNetSSL -lPocoNet -lPocoCrypto -lPocoJSON -lPocoXML -lPocoUtil -lPocoFoundation"
LINK="craftos2-lua/src/liblua.dylib $POCO_LIBS -lcrypto -lssl -lSDL2 -lpng -framework ApplicationServices"

echo "[1/4] liblua"
[ -f craftos2-lua/src/liblua.dylib ] || make -C craftos2-lua macosx >/dev/null

echo "[2/4] configure (headless deps only)"
[ -f Makefile ] || ./configure --without-png --without-webp --without-ncurses --without-sdl_mixer --with-txt >/dev/null

echo "[3/4] emulator objects + archive (everything except main.o)"
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" >/dev/null 2>&1 || true   # final binary link fails (no -lpng); objects are what we need
ar rcs embed/libcraftos2.a $(ls obj/*.o | grep -v '/main.o$')

echo "[4/4] gps_test"
clang++ -std=c++17 -Isrc -Iapi -Icraftos2-lua/include \
  embed/gps_test.cpp embed/libcraftos2.a $LINK -o embed/gps_test

echo "done. run: DYLD_LIBRARY_PATH=\$PWD/craftos2-lua/src ./embed/gps_test ~/craftos2-rom"
