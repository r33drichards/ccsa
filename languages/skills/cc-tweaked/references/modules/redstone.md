# redstone

Get and set redstone signals on the six sides of the computer. Also aliased as `rs` (e.g. `rs.getInput("back")`).

Source: https://tweaked.cc/module/redstone.html

Sides: `"top"`, `"bottom"`, `"left"`, `"right"`, `"front"`, `"back"`.

Three control types:
- **Binary** — on/off; strengths 1 and 15 treated alike.
- **Analogue** — actual strength 0-15.
- **Bundled** — 16 independent on/off channels (e.g. Project:Red cables), one per colour from `colors.white` (first) to `colors.black` (last); represented as a bitfield of colour values.

A `redstone` event fires whenever an input changes — wait on it instead of polling.

## Functions

- `getSides()` → `{ string... }` — the six side names.
- `setOutput(side, on)` — binary output (on emits strength 15).
- `getOutput(side)` → `boolean`
- `getInput(side)` → `boolean`
- `setAnalogOutput(side, value)` / `setAnalogueOutput` — set strength 0-15 (throws if out of range).
- `getAnalogOutput(side)` / `getAnalogueOutput` → `number` 0-15.
- `getAnalogInput(side)` / `getAnalogueInput` → `number` 0-15.
- `setBundledOutput(side, output)` — set bundled output to a colour bitfield (e.g. `colors.combine(colors.red, colors.blue)`).
- `getBundledOutput(side)` → `number` bitfield.
- `getBundledInput(side)` → `number` bitfield.
- `testBundledInput(side, mask)` → `boolean` — are all colours in `mask` on?

## Patterns

Blink:
```lua
while true do
  rs.setOutput("top", not rs.getOutput("top"))
  sleep(0.5)
end
```

Comparator (subtract mode), event-driven:
```lua
while true do
  local rear  = rs.getAnalogueInput("back")
  local sides = math.max(rs.getAnalogueInput("left"), rs.getAnalogueInput("right"))
  rs.setAnalogueOutput("front", math.max(rear - sides, 0))
  os.pullEvent("redstone")
end
```

Bundled cable:
```lua
rs.setBundledOutput("back", colors.combine(colors.red, colors.lime))
if rs.testBundledInput("back", colors.red) then ... end
```
