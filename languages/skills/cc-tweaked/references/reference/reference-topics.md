# Reference topics

Condensed from https://tweaked.cc/reference/<name>.html.

## Block details

Returned by `turtle.inspect*` and `commands.getBlockInfo`. Shape:
```lua
{
  name  = "minecraft:oak_log",          -- registry id
  state = { axis = "x", ... },           -- blockstate properties
  tags  = { ["minecraft:logs"] = true }, -- block tags (set-like)
}
```
`turtle.inspect()` returns `has_block, data` — check `has_block` first.

## Item details

Returned by `turtle.getItemDetail(slot, detailed)`, `inventory.getItemDetail`, `inventory.list` (basic form).
Basic (cheap) form:
```lua
{ name = "minecraft:dirt", count = 13, nbt = "<hash or nil>" }
```
Detailed (`detailed=true`, slower) adds, among others:
```lua
{
  name, count, displayName, maxCount,
  damage, maxDamage,           -- for tools (nil otherwise)
  durability,                  -- 0-1
  tags = { ["minecraft:..."] = true },
  enchantments = { { name, level, displayName }, ... },
  ...
}
```
`nbt` in the basic form is just a hash to distinguish otherwise-identical stacks — it's not the NBT data itself.

## Entity details

Returned by `commands.getEntities`/`getEntityInfo` on command computers: tables with fields like `name`, `id`, `nbt`, position, etc. (command-computer only).

## Computer startup

When a computer turns on it runs startup files:
- It runs `/startup.lua` (or `/startup` for legacy), and also files inside the `/startup/` directory in alphabetical order.
- Disks may also have a `startup` file; settings control whether disk startup is allowed.
- Use this to auto-launch a program. See guide: https://tweaked.cc/guide/startup.html

## CraftOS exception protocol

By default Lua errors are plain strings. CraftOS supports a richer convention: an error value may be a table with a `__tostring` metamethod or a structured exception so tools can display it nicely. Most programs just `error("message")` or `error("message", 0)` (the `0` suppresses the `file:line:` prefix). `pcall`/`xpcall` catch errors as usual.

## Lua 5.2/5.3 features in CC:Tweaked

CC:Tweaked runs on the Cobalt Lua VM, which is Lua 5.1 with selected 5.2/5.3 features back-ported. Available niceties include: `goto`/labels, the `\xNN`/`\u{...}` string escapes, integer-ish handling, `table.pack`/`table.unpack`/`table.move`, `math.type` (where applicable), bitwise ops via `bit32`, `string.pack`/`unpack` in newer versions, and `utf8` helpers. Treat it as "Lua 5.1 plus extras"; check `os.version`/feature detection rather than assuming a specific 5.x feature.

## Incompatibilities between versions (gotchas)

- Lua 5.0's pseudo-arg `arg` for varargs is gone — use `...`.
- Environments use the `_ENV` upvalue; `getfenv`/`setfenv` only work on Lua functions with an `_ENV` upvalue, and `setfenv` is otherwise a no-op.
- `load`/`loadstring` default to the global environment `_G`, not the current coroutine's environment.
See https://tweaked.cc/reference/breaking_changes.html for the full list.
