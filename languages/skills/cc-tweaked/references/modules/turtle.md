# turtle

Turtles are robotic devices that break/place blocks, attack mobs, and move about the world. They have a 16-slot internal inventory.

Source: https://tweaked.cc/module/turtle.html

## Key concepts

- **Movement**: turtles move one block at a time on Minecraft's grid. `forward`/`back` move in the facing direction; `up`/`down` move vertically. To move sideways, `turnLeft`/`turnRight` then move.
- **Fuel**: moving (not turning) consumes fuel. With no fuel, movement functions return `false`. If a turtle won't move, check fuel first. Servers may disable fuel, in which case fuel functions return `"unlimited"`.
- **Error handling**: most turtle functions return `true` on success or `false, reason` on failure rather than erroring. Check return values or wrap in `assert`, e.g. `assert(turtle.forward())`.
- **Upgrades**: two slots (left/right). Any diamond tool works as an upgrade; pickaxe → `dig`, sword → `attack`. Speakers and ender/wireless modems can be equipped and then accessed as the `"left"`/`"right"` peripheral. Equip via `equipLeft`/`equipRight`.
- **Fuel limits**: normal turtles hold 20,000; advanced turtles 100,000.

## Movement

- `forward()` → `boolean, string|nil` — move forward one block.
- `back()` → `boolean, string|nil` — move backwards one block.
- `up()` → `boolean, string|nil` — move up one block.
- `down()` → `boolean, string|nil` — move down one block.
- `turnLeft()` → `boolean, string|nil` — rotate 90° left.
- `turnRight()` → `boolean, string|nil` — rotate 90° right.

## Digging (requires a tool upgrade)

- `dig([side])` → `boolean, string|nil` — break block in front. `side` is `"left"`/`"right"` to pick the tool.
- `digUp([side])` / `digDown([side])` → same, above/below.

## Placing

- `place([text])` → `boolean, string|nil` — place block/item in front. `text` sets sign contents. Placing lets items interact (buckets pick up/place fluids, wheat breeds cows) but cannot do arbitrary interactions like pressing buttons.
- `placeUp([text])` / `placeDown([text])` → same, above/below.

## Inventory

- `select(slot)` → `true` — set the selected slot (1-16). Throws if out of range.
- `getSelectedSlot()` → `number` — current slot.
- `getItemCount([slot])` → `number` — items in slot (defaults to selected).
- `getItemSpace([slot])` → `number` — remaining space in the stack.
- `getItemDetail([slot [, detailed]])` → `table|nil` — item info; `detailed=true` returns much more at a time cost. See Item details reference. Example return: `{ name = "minecraft:dirt", count = 13 }`.
- `compareTo(slot)` → `boolean` — compare selected slot to another slot.
- `transferTo(slot [, count])` → `boolean` — move items from selected slot to another.
- `drop([count])` → `boolean, string|nil` — drop selected stack into inventory in front, or into world if none.
- `dropUp([count])` / `dropDown([count])` → same, above/below.
- `suck([count])` → `boolean, string|nil` — pull items from inventory in front (or floating items) into the first acceptable slot starting at the selected one.
- `suckUp([count])` / `suckDown([count])` → same, above/below.

## Sensing / comparison

- `detect()` → `boolean` — solid (non-air, non-liquid) block in front?
- `detectUp()` / `detectDown()` → same, above/below.
- `compare()` → `boolean` — block in front equals item in selected slot?
- `compareUp()` / `compareDown()` → same, above/below.
- `inspect()` → `boolean, table|string` — block info in front (name, state, tags). See Block details reference.
- `inspectUp()` / `inspectDown()` → same, above/below.

Example:
```lua
local has_block, data = turtle.inspect()
if has_block then
  print(textutils.serialise(data))
  -- { name = "minecraft:oak_log", state = { axis = "x" }, tags = { ["minecraft:logs"] = true } }
end
```

## Combat

- `attack([side])` → `boolean, string|nil` — attack entity in front.
- `attackUp([side])` / `attackDown([side])` → same, above/below.

## Fuel

- `getFuelLevel()` → `number | "unlimited"` — current fuel.
- `getFuelLimit()` → `number | "unlimited"` — max fuel.
- `refuel([count])` → `true` | `false, string` — consume up to `count` fuel items from the selected slot. `refuel(0)` checks whether the selected item is combustible without consuming it.

Example:
```lua
local level = turtle.getFuelLevel()
if level == "unlimited" then error("Turtle does not need fuel", 0) end
local ok, err = turtle.refuel()
if ok then
  print(("Refuelled, level is %d"):format(turtle.getFuelLevel()))
else
  printError(err)
end
```

## Upgrades

- `equipLeft()` / `equipRight()` → `true` | `false, string` — equip item in selected slot to that side; the previous upgrade is returned to the inventory. Empty slot just unequips.
- `getEquippedLeft()` / `getEquippedRight()` → `table|nil` — info about the equipped upgrade.

## Crafting (crafty turtle)

- `craft([limit=64])` → `true` | `false, string` — craft from inventory laid out as a crafting grid (e.g. slots 1 and 5 = planks → sticks). All other slots must be empty. `craft(0)` validates a recipe without crafting. Throws if limit < 0 or > 64.

## Deprecated

- `native` — the builtin table; no longer behaves differently from the main API. Don't use.
