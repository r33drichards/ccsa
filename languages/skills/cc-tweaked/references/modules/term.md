# term

Interact with a computer's terminal (or monitors) — write text, manage the cursor, set colours, draw with blit.

Source: https://tweaked.cc/module/term.html

All British/American spellings exist: `setTextColour`/`setTextColor`, etc. Colour args are `colors` constants (numbers). Only 16 colours on screen at once.

## Writing & cursor

- `write(text)` — write at the cursor, advancing it. Low-level: no wrapping or line breaks. For wrapped output use global `write`/`print`.
- `getCursorPos()` → `x, y`
- `setCursorPos(x, y)` — top-left is `(1, 1)`.
- `getCursorBlink()` → `boolean`
- `setCursorBlink(blink)` — show/hide blinking cursor.
- `getSize()` → `width, height`
- `clear()` — fill terminal with current background colour.
- `clearLine()` — clear the cursor's line.
- `scroll(y)` — shift all content up by `y` lines (negative = down).

Example — absolute positioning:
```lua
term.clear()
term.setCursorPos(1, 1); term.write("First line")
term.setCursorPos(20, 2); term.write("Second line")
```

## Colours

- `setTextColour(colour)` / `getTextColour()` → text colour.
- `setBackgroundColour(colour)` / `getBackgroundColour()` → background colour, used by `write`/`clear`.
- `isColour()` → `boolean` — does the terminal support colour? Non-colour terminals show colours as greyscale.

Use `colors`/`colours` constants. The `paintutils` API has helpers for drawing graphics on top of `setBackgroundColour`.

## blit (fast coloured text)

`blit(text, textColour, backgroundColour)` — write `text` where each character's fg/bg comes from same-length hex-digit strings (each digit `0`-`f` maps to a colour; `a` = purple). All three must be equal length.

```lua
-- "Hello, world!" with per-char colours, black background:
term.blit("Hello, world!", "01234456789ab", "0000000000000")
```

## Palette (recolour the 16 slots)

You can't exceed 16 on-screen colours, but you can change which RGB each slot maps to.
- `setPaletteColour(index, rgb)` where `rgb` is a 24-bit int (e.g. `0xFF0000`), or `setPaletteColour(index, r, g, b)` with channels 0-1.
- `getPaletteColour(colour)` → `r, g, b` (each 0-1).
- `nativePaletteColour(colour)` → `r, g, b` — the default palette value for a colour.

## Redirection (terminal objects)

A "Redirect" is any object implementing the terminal methods above. Monitors and `window` objects are Redirects.
- `redirect(target)` → previous target — send all `term` output to `target` (a monitor, window, etc.).
- `current()` → the current terminal Redirect object.
- `native()` → the computer's native (physical) terminal object.

Pattern — draw to a monitor then restore:
```lua
local mon = peripheral.find("monitor")
local prev = term.redirect(mon)
print("on the monitor")
term.redirect(prev)
```

The `term` table itself is a Redirect, so all the above methods (`write`, `setCursorPos`, `blit`, palette, …) are also available on any object returned by `term.current()`, `window.create(...)`, or a wrapped monitor.
