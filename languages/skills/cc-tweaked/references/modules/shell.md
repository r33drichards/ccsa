# shell

Access to CraftOS's command line. NOTE: `shell` is not a global API — it's a program that injects its table into programs it launches. So `shell` is available to programs run from the shell, but NOT inside libraries loaded via `os.loadAPI`/`require`. Multiple shells can run at once.

Source: https://tweaked.cc/module/shell.html

## How a command resolves
1. Alias expansion (`ls`/`dir` → `list`).
2. Program path search — colon-separated dirs (e.g. `.`, `/rom/programs`).
3. Hashbang: a file starting with `#!` is passed to the named program instead of being run as Lua (1.103.0+).

## Running programs

- `run(...)` → `boolean` — args concatenated then parsed as a command line. `shell.run("program a b")` == `shell.run("program", "a", "b")`. Each program gets its own environment with `arg`.
- `execute(command, ...)` → `boolean` — like `run` but each arg is passed verbatim (not re-parsed). `shell.execute("echo", "b c")` → one arg `"b c"`.
- `exit()` — make the shell exit after the current program finishes (top-level shell → shutdown). Does NOT terminate your program immediately.
- `getRunningProgram()` → `string` — path of the current program.

## Working directory & path

- `dir()` → `string` — current working directory (shown in the prompt).
- `setDir(dir)` — change it (throws if not a directory).
- `path()` → `string` — the program path.
- `setPath(path)` — set the program path.
- `resolve(path)` → `string` — relative → absolute (relative to `dir()`). Use this before passing paths to `fs`, which is always absolute.
- `resolveProgram(command)` → `string|nil` — find a program via path + aliases.
- `programs([include_hidden])` → `{ string... }` — programs on the path.

## Aliases

- `setAlias(command, program)`
- `clearAlias(command)`
- `aliases()` → `table` — current aliases.

## Tab completion

- `complete(sLine)` → `{ string... }` — complete a whole command line.
- `completeProgram(program)` → `{ string... }`
- `setCompletionFunction(program, complete)` — register a completion fn for a program. See `cc.shell.completion` for helpers.
- `getCompletionInfo()` → `table` — all registered completion functions.

## Multishell tabs

- `openTab(...)` → `number` (id) — run a command in a new `multishell` tab.
- `switchTab(id)` — switch to a tab.
