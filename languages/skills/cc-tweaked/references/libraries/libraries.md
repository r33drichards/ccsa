# cc.* libraries

These are loaded with `require`, not globals: `local x = require("cc.module")`.

Sources: https://tweaked.cc/library/<name>.html

## cc.expect — argument validation (1.84.0+)

Helpers for verifying function arguments. Used throughout CraftOS.
- `expect(index, value, ...types)` → `value` — assert `value` is one of the given type strings (e.g. `"number"`, `"string"`, `"nil"`); errors with a helpful message naming the argument position. Returns the value so you can inline it.
- `field(tbl, key, ...types)` → `value` — same for a table field.
- `range(num [, min [, max]])` → `num` — assert a number is in range.

```lua
local expect = require("cc.expect").expect
local function greet(name, times)
  expect(1, name, "string")
  expect(2, times, "number", "nil")
end
```

## cc.pretty — pretty printer (1.87.0+)

Build "documents" (`Doc`) that control layout, then render the most compact fitting layout. Based on Wadler's "A Prettier Printer".
- Constants: `empty`, `space`, `line` (hard break), `space_line` (break that becomes a space when grouped on one line).
- `text(text [, colour])` → `Doc` — text, optionally coloured (a `colors` value).
- `concat(...)` → `Doc` — join docs (the `Doc` metatable also overloads `..`).
- `nest(depth, doc)` → `Doc` — indent continuation lines by `depth` spaces.
- `group(doc)` → `Doc` — render on one line if it fits, else expand.
- `write(doc [, ribbon_frac=0.6])` / `print(doc [, ribbon_frac=0.6])` — display (print adds a newline).
- `render(doc [, width [, ribbon_frac=0.6]])` → `string`.
- `pretty(obj [, options])` → `Doc` — turn any Lua value into a doc. `options`: `{ function_args = boolean, function_source = boolean }`.
- `pretty_print(obj [, options])` — shortcut for `print(pretty(obj))`.

```lua
local pretty = require("cc.pretty")
pretty.pretty_print({ 1, 2, 3 })
pretty.print(pretty.group(pretty.text("hello") .. pretty.space_line .. pretty.text("world")))
```

## cc.strings — string helpers (1.95.0+)

- `wrap(text [, width])` → `{ string... }` — split text into lines fitting `width` (default terminal width).
- `ensure_width(line [, width])` → `string` — pad/truncate a line to exactly `width`.
- `split(str, deliminator [, plain [, limit]])` → `{ string... }` — split on a (Lua-pattern, or `plain`) delimiter (1.112.0+).

## cc.completion — completion helpers for `read`

Functions returning completion candidates, for the `read` completion callback.
- `choice(text, choices [, add_space])`
- `peripheral(text [, add_space])`
- `side(text [, add_space])`
- `setting(text [, add_space])`
- `command(text [, add_space])`

## cc.shell.completion — completion helpers for shell programs

Build completion functions for `shell.setCompletionFunction`.
- `file(shell, text)`, `dir(shell, text)`, `dirOrFile(...)`, `program(shell, text)`, `programWithArgs(...)`
- `choice(...)`, `peripheral(...)`, `side(...)`, `setting(...)`, `command(...)`
- `build(...)` — compose per-argument completers into one function.

```lua
local completion = require("cc.shell.completion")
local complete = completion.build(
  { completion.choice, { "get", "set" } },
  completion.file
)
shell.setCompletionFunction("myprog", complete)
```

## cc.require — require/package for custom environments

A pure-Lua implementation of `require`/`package`, useful when running code in a custom environment.
- `make(env, dir)` → `require, package` — create a `require` function whose module search is rooted at `dir`.

## cc.audio.dfpwm — DFPWM codec (1.100.0+)

Convert between DFPWM1a streams and amplitude lists for `speaker.playAudio`.
- `make_encoder()` → `function(samples) -> string` — stateful encoder.
- `make_decoder()` → `function(string) -> samples` — stateful decoder.
- `encode(samples)` / `decode(data)` — one-shot stateless versions.

```lua
local dfpwm = require("cc.audio.dfpwm")
local decoder = dfpwm.make_decoder()
local speaker = peripheral.find("speaker")
for chunk in io.lines("data/example.dfpwm", 16 * 1024) do
  local buffer = decoder(chunk)
  while not speaker.playAudio(buffer) do os.pullEvent("speaker_audio_empty") end
end
```

## cc.image.nft — NFT image format

Read and draw "Nitrogen Fingers Text" images (coloured terminal art).
- `parse(image)` → table — parse NFT string into a drawable structure.
- `load(path)` → table — read and parse a file.
- `draw(image, xPos, yPos [, target])` — draw at a position on the terminal (or a given Redirect/window).

## cc.base64 — Base64 (1.111.0+)

- `encode(data)` → `string`
- `decode(str)` → `string`
