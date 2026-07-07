{
  description = "CraftOS-PC + Rust MCP server (GPS/rednet multi-computer testing)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # craftos2-lua is a git submodule of this repo. Submodules + flakes are
    # awkward (`self` doesn't carry submodule contents), so we pin it as a
    # separate non-flake input at the exact submodule commit and splice it into
    # the source tree at build time.
    craftos2-lua = {
      url = "github:MCJack123/craftos2-lua/d394c303f76103d2251d73b6d5d1ff01877a244f";
      flake = false;
    };

    # The CraftOS-PC ROM (bios.lua + rom/) is loaded at runtime by the embedded
    # emulator (setROMPath). Pin the same commit the repo was developed against.
    craftos2-rom = {
      url = "github:MCJack123/craftos2-rom/e6f63a1b168a4e37c5b06b090003219085f638cf";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, craftos2-lua, craftos2-rom }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (sys: f nixpkgs.legacyPackages.${sys});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # Rust toolchain (per "use nix for cargo") + the emulator's C/C++ deps.
          # GPS/rednet headless build needs only SDL2 + Poco + OpenSSL + lua; the
          # GUI/audio/PDF deps are disabled at ./configure time.
          packages = with pkgs; [
            rustc
            cargo
            rust-analyzer
            clang
            pkg-config
            gnumake
            SDL2
            poco
            openssl
            ncurses
            # darwin.cpp hard-includes <png++/png.hpp>; provide the headers even
            # though screenshots are compiled out (NO_PNG).
            libpng
            pngpp
          ];

          # Help ./configure + the linker find Poco/OpenSSL headers and libs.
          shellHook = ''
            export CRAFTOS_NIX=1
            echo "craftos2 dev shell: rustc $(rustc --version 2>/dev/null | cut -d' ' -f2), $(cargo --version 2>/dev/null)"
          '';
        };
      });

      packages = forAll (pkgs:
        let
          lib = pkgs.lib;
          inherit (pkgs.stdenv) isDarwin;
          luaTarget = if isDarwin then "macosx" else "linux";
          luaExt = if isDarwin then ".dylib" else ".so";

          # craftos-mcp only uses SDL2 for SDL_Init(SDL_INIT_TIMER) and linking —
          # it never opens a window or audio device, so its GUI/audio backends are
          # dead weight in the image. We intentionally do NOT override them: on
          # current nixpkgs `pkgs.SDL2` is `sdl2-compat` (SDL2-on-SDL3), whose
          # arguments differ from classic SDL2, and the build only runs in CI
          # (ample disk) — not locally — so closure size is a follow-up, not a
          # blocker. Slimming would mean overriding the underlying sdl3 backends.
          sdl2 = pkgs.SDL2;

          craftos-mcp = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "craftos-mcp";
            version = "0.1.0";

            src = self;

            # Vendor the Rust dependency closure from mcp/Cargo.lock for an
            # offline `cargo build`.
            cargoDeps = pkgs.rustPlatform.importCargoLock {
              lockFile = ./mcp/Cargo.lock;
            };
            cargoRoot = "mcp";

            nativeBuildInputs = with pkgs; [
              cargo
              rustc
              rustPlatform.cargoSetupHook
              pkg-config
              gnumake
              makeWrapper
            ] ++ lib.optional pkgs.stdenv.isLinux pkgs.autoPatchelfHook;

            buildInputs = (with pkgs; [
              poco
              openssl
              ncurses
              readline # craftos2-lua's linux/macosx targets link the lua CLI against readline
              libpng
              pngpp
            ]) ++ [ sdl2 ];

            # `self` carries the submodule path as an empty dir; replace it with
            # the pinned craftos2-lua source.
            postUnpack = ''
              chmod -R u+w "$sourceRoot"
              rm -rf "$sourceRoot/craftos2-lua"
              cp -r ${craftos2-lua} "$sourceRoot/craftos2-lua"
              chmod -R u+w "$sourceRoot/craftos2-lua"
            '';

            buildPhase = ''
              runHook preBuild

              export HOME="$TMPDIR"
              patchShebangs configure || true

              echo "[1/4] liblua (${luaTarget})"
              make -C craftos2-lua ${luaTarget} -j"$NIX_BUILD_CORES"

              echo "[2/4] configure (headless deps only)"
              ./configure --without-png --without-webp --without-ncurses --without-sdl_mixer --with-txt

              echo "[3/4] emulator objects (final binary link fails; we only need obj/*.o)"
              make -j"$NIX_BUILD_CORES" || true

              echo "[3b/4] archive everything except main.o"
              ar rcs embed/libcraftos2.a $(ls obj/*.o | grep -v '/main.o$')

              echo "[4/4] cargo build --release (mcp crate)"
              ( cd mcp && cargo build --release --offline )

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/bin $out/lib $out/share/craftos $out/share/craftos-mcp

              install -Dm755 mcp/target/release/craftos-mcp $out/bin/.craftos-mcp-unwrapped

              # liblua is linked dynamically; ship it alongside the binary.
              install -Dm755 craftos2-lua/src/liblua${luaExt} $out/lib/liblua${luaExt}

              # Runtime data: the ROM (setROMPath / $CRAFTOS_ROM) and the turtle
              # fake-world engine ($CRAFTOS_SIM_DIR/engine.lua).
              cp -r ${craftos2-rom}/. $out/share/craftos/
              cp -r sim/. $out/share/craftos-mcp/

              runHook postInstall
            '';

            # autoPatchelfHook (Linux) rewrites the binary's RPATH to find liblua
            # in $out/lib plus the Poco/SDL2/openssl/png closure. On Darwin the
            # store-path install names already resolve; only liblua (relative
            # install name) needs an extra rpath entry.
            postFixup = ''
              ${lib.optionalString isDarwin ''
                install_name_tool -add_rpath $out/lib $out/bin/.craftos-mcp-unwrapped || true
              ''}
              makeWrapper $out/bin/.craftos-mcp-unwrapped $out/bin/craftos-mcp \
                --set CRAFTOS_ROM $out/share/craftos \
                --set CRAFTOS_SIM_DIR $out/share/craftos-mcp
            '';

            meta = {
              description = "MCP server driving an embedded CraftOS-PC for declarative CC simulation/tests";
              mainProgram = "craftos-mcp";
              platforms = systems;
            };
          });

          docker = pkgs.dockerTools.buildLayeredImage {
            name = "craftos-mcp";
            tag = "latest";
            contents = [ craftos-mcp pkgs.cacert ];
            # The emulator writes logs/scratch under /tmp.
            extraCommands = "mkdir -m 1777 -p tmp";
            config = {
              Entrypoint = [ "${craftos-mcp}/bin/craftos-mcp" ];
              Cmd = [ "--transport" "all" "--port" "8121" ];
              ExposedPorts = { "8121/tcp" = { }; };
              Env = [
                "PORT=8121"
                "CRAFTOS_ROM=${craftos-mcp}/share/craftos"
                "CRAFTOS_SIM_DIR=${craftos-mcp}/share/craftos-mcp"
              ];
            };
          };
        in {
          inherit craftos-mcp docker;
          default = craftos-mcp;
        });
    };
}
