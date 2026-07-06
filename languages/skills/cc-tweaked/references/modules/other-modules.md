# Other global modules

Condensed reference for the remaining globals. Canonical docs at https://tweaked.cc/module/<name>.html — fetch a specific page if you need exhaustive parameter notes.

## _G — global environment (defined in bios.lua)

Always-available globals beyond standard Lua:
- `print(...)` → `number` (lines) — print values separated by spaces + newline, with wrapping.
- `write(text)` → `number` (lines) — write text with wrapping, no newline.
- `printError(...)` — print to stderr-style (red).
- `read([replaceChar [, history [, completeFn [, default]]]])` → `string` — read a line of input. `replaceChar` masks input (e.g. `"*"`); `history` is a table of past entries; `completeFn(partial)` returns completion candidates; `default` prefills.
- `sleep(time)` — yield for `time` seconds (rounds up to 0.05). Pumps events.
- `_HOST` — string describing the host (e.g. `"ComputerCraft 1.x (Minecraft 1.x)"`).
- `_CC_DEFAULT_SETTINGS` — default settings string.

## parallel — run functions concurrently

Each function runs as a coroutine, multiplexing on event waits (cooperative, not true parallelism).
- `parallel.waitForAny(...)` → `number` — run all fns until ANY returns; returns the index that finished.
- `parallel.waitForAll(...)` — run all fns until ALL return.

```lua
parallel.waitForAny(
  function() while true do local e = os.pullEvent("key"); ... end end,
  function() sleep(10) end   -- timeout
)
```
A function that returns ends its branch; an error in any branch propagates out.

## window — terminal redirect over a region

`window.create(parent, x, y, width, height [, visible])` → `Window` — a `term.Redirect` occupying a rectangle of `parent` (another Redirect, e.g. the term or a monitor).
A Window has all `term` methods plus:
- `setVisible(visible)` / `isVisible()` — when invisible, draws are buffered, not shown.
- `redraw()` — force a redraw to the parent.
- `restoreCursor()` — move the parent cursor to this window's cursor.
- `getPosition()` → `x, y`
- `reposition(x, y [, width, height [, parent]])` — move/resize.
- `getLine(y)` → `text, fg, bg` (blit strings).

Useful for double-buffering (set invisible, draw, set visible) and tiling UIs.

## gps — locate the computer via wireless modems

- `gps.CHANNEL_GPS = 65534` — the channel GPS uses.
- `gps.locate([timeout=2 [, debug]])` → `x, y, z` | `nil` — trilaterate position from GPS hosts in range. Needs ≥4 hosts (or ≥3 if not ambiguous). Requires a wireless/ender modem attached.

Set up hosts with the `gps host <x> <y> <z>` program. See guide: https://tweaked.cc/guide/gps_setup.html

## settings — persisted configuration

- `define(name, options)` — register a setting with `{ description, default, type }`.
- `undefine(name)`
- `set(name, value)` / `get(name [, default])` / `unset(name)`
- `getDetails(name)` → table.
- `clear()` — reset all.
- `getNames()` → `{ string... }`
- `load([path="/.settings"])` → `boolean` — read settings from a file.
- `save([path="/.settings"])` → `boolean` — write them.

Changing a setting fires a `setting_changed` event.

## colors / colours

16 colour constants (numbers, powers of two): `white, orange, magenta, lightBlue, yellow, lime, pink, gray, lightGray, cyan, purple, blue, brown, green, red, black`. (`colours` is the British alias, with `colours.grey`/`lightGrey`.)
- `combine(...)` → `number` — bitwise-OR colours (for bundled cable).
- `subtract(colors, ...)` → `number` — remove colours from a set.
- `test(colors, color)` → `boolean` — is `color` in the set?
- `packRGB(r, g, b)` / `unpackRGB(rgb)` — between channels (0-1) and a 24-bit int.
- `toBlit(color)` → `string` — the single hex digit used by `term.blit`. `fromBlit(hex)` → color.

## keys — keyboard key codes

Maps key names to codes queued by the `key` event, e.g. `keys.enter`, `keys.space`, `keys.leftCtrl`, `keys.a`, `keys.f3`, `keys.up`.
- `keys.getName(code)` → `string|nil` — reverse lookup.

## vector — 3D vectors

`vector.new(x, y, z)` → `Vector`. Operators `+ - * /` and methods:
- `add/sub/mul/div`, `dot(o)`, `cross(o)`, `length()`, `normalize()`, `round([tolerance])`, `tostring()`.
Components: `.x`, `.y`, `.z`.

## paintutils — drawing helpers

Work on top of `term` background colour.
- `parseImage(data)` → image; `loadImage(path)` → image (paint `.nfp` format).
- `drawPixel(x, y [, colour])`, `drawLine(x1,y1,x2,y2 [,colour])`, `drawBox(...)`, `drawFilledBox(...)`.
- `drawImage(image, x, y)`.

## multishell — tabbed shells (only present when running under multishell)

- `getCurrent()` → `number`; `getCount()` → `number`; `launch(env, path, ...)` → `number`; `setTitle(id, title)` / `getTitle(id)`; `setFocus(id)` → `boolean`; `getFocus()` → `number`.

## disk — disk drive convenience

Wraps drive peripherals by side/name: `isPresent(name)`, `hasData(name)`, `getMountPath(name)`, `setLabel(name, label)`, `getLabel(name)`, `getID(name)`, `hasAudio(name)`, `getAudioTitle(name)`, `playAudio(name)`, `stopAudio(name)`, `eject(name)`.

## io — Lua-style IO

Emulates Lua's `io`: `io.open(path, mode)` → file, `io.lines([path])`, `io.read(...)`, `io.write(...)`, `io.stdin`/`io.stdout`/`io.stderr`.

## commands — command computers only

For command-block computers: `commands.exec(command)` / `execAsync(command)`, `commands.list(...)`, `commands.getBlockPosition()`, `commands.getBlockInfo(x,y,z)`, `commands.getBlockInfos(...)`, `commands.getEntities(...)` (see Entity details). Also `commands.async` and `commands.native`.

## pocket — pocket computer upgrades

- `pocket.equipBack()` / `pocket.unequipBack()` → `boolean | false, string` — equip/unequip the item in the first inventory slot as the pocket computer's back upgrade.

## help — built-in help files

- `help.path()` / `help.setPath(path)`; `help.lookup(topic)` → path|nil; `help.topics()` → `{ string... }`; `help.completeTopic(prefix)`.
