---
name: skill-editor
description: How to inspect, improve, and create this agent's own skills (the writable SKILL.md library at /codex-home/skills; bundled read-only skills at /opt/languages/skills) using the run_js sandbox's real filesystem access.
---

# Editing your own skills

Skills live in two places on the real container filesystem:

- `/opt/languages/skills/` — the skills shipped with the image (including
  this one). **Read-only**: the sandbox policy denies writes there, and the
  directory is replaced wholesale on every image update, so nothing written
  there could survive anyway.
- `/codex-home/skills/` — **your** skill library. Read+write, backed by a
  persistence volume: skills you create here survive restarts and image
  updates, and are never touched by the bundled set.

Each skill is a directory holding a `SKILL.md`: YAML frontmatter with `name`
and `description` (the description decides when the skill is surfaced),
followed by markdown instructions.

Use `run_js` fs functions — the sandbox policy grants read+write under
`/codex-home/skills` (and `/work`), read-only under `/opt/languages`:

```javascript
// list skills: bundled, then your own
await fs.readdir('/opt/languages/skills');
await fs.readdir('/codex-home/skills');

// read one
await fs.readFile('/opt/languages/skills/skill-editor/SKILL.md');

// create or improve one of YOUR skills
await fs.mkdir('/codex-home/skills/my-new-skill');
await fs.writeFile('/codex-home/skills/my-new-skill/SKILL.md',
`---
name: my-new-skill
description: One line that tells future-you when to reach for this.
---

# My new skill

Concrete, checkable instructions here.
`);
```

Rules of thumb:

- To customize a bundled skill, copy it into `/codex-home/skills/<name>/`
  and edit the copy — writing under `/opt/languages/skills` is denied.
- Changes take effect for **new sessions** — the current thread keeps the
  skill set it started with.
- Keep descriptions specific ("Use when converting a MiniZinc model to…")
  — they are the retrieval key.
- Skills must drive `run_js` (fetch, `/work`, the `/opt/languages` engines).
  There is no shell and no host filesystem beyond the paths above, so never
  write instructions that assume `bash`, `git`, or package managers.
- When you learn something non-obvious that took real effort (an engine
  quirk, a working recipe), capture it as a skill before finishing the task.
