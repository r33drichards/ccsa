# superpowers skills (bundled, read-only)

Vendored from [obra/superpowers](https://github.com/obra/superpowers) **v4.0.3**
(2025-12-26). These are general software-engineering *methodology* skills —
brainstorming before coding, TDD, systematic debugging, writing plans,
verification before completion, etc. — shipped as defaults for the `languages`
build.

## How they work here (adapted for nanocodex)

Upstream superpowers targets Claude Code / an official `superpowers-codex`
bootstrap script. The nanocodex codex agent has **no shell** — its only
capability is the `run_js` sandbox — so that script-based install does not
apply. Instead these skills are baked **read-only** into the image at
`/opt/languages/skills/superpowers/<name>/SKILL.md` and the agent consults them
with `fs.readFile`, exactly like the other bundled skills.

### Tool mapping (from the upstream codex bootstrap)

When a skill references a tool the nanocodex agent doesn't have, substitute:

- **`Skill` tool** → `fs.readFile('/opt/languages/skills/superpowers/<name>/SKILL.md')`.
  There is no skill-loader; reading the file *is* loading the skill.
- **`TodoWrite`** → codex's `update_plan` (the planning/task tool).
- **`Task` / subagents** → generally unavailable. (Only present when the
  operator enables sub-agent sessions via `NANOCODEX_AGENTS_URL`; otherwise do
  the work the subagent would have done yourself.)
- **`Read` / `Write` / `Edit` / `Bash`** → the `run_js` sandbox's `fs.*` on the
  writable areas (`/work`, `/codex-home/skills`); the rest of the fs is
  read-only.

### Precedence

The agent's own writable library at `/codex-home/skills` overrides a bundled
skill of the same name (copy one here to customize it — writes to
`/opt/languages/skills` are denied).

## Refreshing

Re-vendor from a newer superpowers release by copying its `skills/` tree over
`languages/skills/superpowers/` (drop `CREATION-LOG.md` files) and bumping the
version noted above.
