{
  description = "ccsa — naive multi-MCP mini-swe-agent (Ollama Cloud) + languages (picat/craftos wasm) mcp-v8 server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Optional: build mcp-v8 from source. The default path is the prebuilt
    # release binary (see fetch-mcp-v8.sh), which avoids the Rust/V8 build.
    mcp-js.url = "github:r33drichards/mcp-js/claude/http-allowed-hosts";
  };

  outputs = { self, nixpkgs, mcp-js }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      # Escape hatch to build mcp-v8 from source (`nix build .#mcp-v8`). Not the
      # default — run-languages-mcp.sh prefers the fetched prebuilt bin/mcp-v8.
      packages = forSystems (system: pkgs: {
        mcp-v8 = mcp-js.packages.${system}.default;
      });

      devShells = forSystems (system: pkgs: {
        # Everything main.py + the launcher need on PATH. mcp-v8 itself is the
        # prebuilt binary fetched by fetch-mcp-v8.sh, not built here.
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs pkgs.uv pkgs.curl ];
          shellHook = ''
            [ -x ./bin/mcp-v8 ] || ./fetch-mcp-v8.sh || true
          '';
        };
      });
    };
}
