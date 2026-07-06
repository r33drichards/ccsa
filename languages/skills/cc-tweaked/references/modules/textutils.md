# textutils

Utilities for formatting/printing text and serialising data (Lua literals and JSON).

Source: https://tweaked.cc/module/textutils.html

## Printing helpers

- `slowWrite(text [, rate=20])` — write char-by-char (no newline); `rate` chars/sec.
- `slowPrint(text [, rate=20])` — same but with a trailing newline.
- `formatTime(nTime [, twentyFourHour])` → `string` — format an `os.time` value, e.g. `"6:30 PM"` or `"18:30"`.
- `pagedPrint(text [, free_lines])` → `number` — like `print` but pauses with "Press any key to continue" when output would scroll. `free_lines` = lines shown before the first prompt (set to `height - 2` to fill the screen).
- `tabulate(...)` — print rows as aligned columns. Args are row tables `{ "a", "b" }` or a `colors` number to set the colour of following rows.
- `pagedTabulate(...)` — like `tabulate` but pages when it overflows.

```lua
textutils.tabulate(colors.orange, {"1","2","3"}, colors.lightBlue, {"A","B","C"})
```

## Serialisation (Lua)

- `serialize(t, opts)` / `serialise` → `string` — convert a Lua object to a textual (Lua-literal) representation. `opts`: `{ compact = boolean, allow_repetitions = boolean }`. `compact` removes whitespace; `allow_repetitions` permits the same table appearing multiple times (but still errors on cycles).
- `unserialize(s)` / `unserialise` → `value|nil` — parse a string produced by `serialize` back into a Lua object; `nil` if it can't be parsed.

```lua
local s = textutils.serialize({ name = "dirt", count = 13 })
local t = textutils.unserialize(s)
```

## Serialisation (JSON)

- `serializeJSON(value [, opts])` / `serialiseJSON` → `string`. `opts`: `{ nbt_style = boolean, unicode_strings = boolean }` (older API also accepted a boolean second arg for nbt_style). `nbt_style` emits Minecraft's NBT-flavoured JSON.
- `unserializeJSON(s [, options])` / `unserialiseJSON` → `value|nil [, string err]`. `options`: `{ nbt_style = boolean, parse_null = boolean, parse_empty_array = boolean }`.
- `empty_json_array` — sentinel table marking an empty JSON array (vs empty object).
- `json_null` — sentinel table for JSON `null`.

```lua
local body = textutils.serializeJSON({ ok = true, items = textutils.empty_json_array })
local data = textutils.unserializeJSON('{"a":1}')
```

## Misc

- `urlEncode(str)` → `string` — percent-encode for URLs / POST bodies.
- `complete(searchText [, searchTable])` → `{ string... }` — completion candidates for a partial Lua expression (used by the Lua REPL).
