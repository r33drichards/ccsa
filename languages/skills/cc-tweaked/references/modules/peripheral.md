# peripheral

Find and control peripherals — blocks (or turtle/pocket upgrades) like monitors, speakers, modems, drives, chests.

Source: https://tweaked.cc/module/peripheral.html

## Referencing peripherals

- **Adjacent**: named by direction — `"top"`, `"bottom"`, `"left"`, `"right"`, `"front"`, `"back"`.
- **Wired modems**: place a modem on the computer, run networking cable to the peripheral, modem on it, right-click to attach. The peripheral then gets a network name (e.g. `"monitor_0"`) usable like a side name.
- List all with the `peripherals` program or `getNames()`.

## Peripheral types

A *type* is a string describing what a peripheral is and what methods it has (e.g. `"speaker"`, `"monitor"`). Since 1.99 a peripheral can have multiple types — a chest is both `"minecraft:chest"` and `"inventory"`.

## Functions

- `getNames()` → `{ string... }` — all attached peripheral names.
- `isPresent(name)` → `boolean`
- `getType(peripheral)` → `string...` — types of a named or wrapped peripheral (multiple since 1.99); `nil` if absent.
- `hasType(peripheral, type)` → `boolean|nil`
- `getMethods(name)` → `{ string... }|nil` — method names available.
- `getName(peripheral)` → `string` — name of a wrapped peripheral.
- `call(name, method, ...)` → method's return values — invoke a method by name.
- `wrap(name)` → `table|nil` — table of the peripheral's methods (call instead of repeated `call`).
- `find(type [, filter])` → `table...` — all wrapped peripherals of `type`. `filter(name, wrapped) -> boolean` narrows the results.

## Patterns

Call vs wrap:
```lua
peripheral.call("top", "write", "hi")          -- one-off
local mon = peripheral.wrap("top"); mon.write("hi")  -- reuse
```

Find by type (location-independent):
```lua
local speaker = peripheral.find("speaker")
speaker.playNote("harp")

local monitors = { peripheral.find("monitor") }
for _, m in pairs(monitors) do m.write("Hello") end

-- filter: only wireless modems
local modems = { peripheral.find("modem", function(name, m) return m.isWireless() end) }

-- neat trick: open rednet on every modem
peripheral.find("modem", rednet.open)
```

Guard before use:
```lua
if peripheral.isPresent("right") and peripheral.hasType("right", "inventory") then
  local inv = peripheral.wrap("right")
  ...
end
```

## Related events

- `peripheral` — fired when a peripheral is attached.
- `peripheral_detach` — fired when one is detached.
