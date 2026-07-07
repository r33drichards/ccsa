---
name: turtle-sorter
description: Use when writing or auto-researching a stationary CC:Tweaked (CC:Tweaked) turtle that sorts the items in ADJACENT chests IN PLACE — consolidating same items into minimal stacks and ordering slots by item name — validated against a create_sort_sim arena.
---

# turtle-sorter

## Task

A stationary turtle sorts each **adjacent chest** (above, below, in front) **in
place**: within a chest, merge same items into the fewest stacks and order the
slots by item name. Do NOT move items between chests; do NOT lose or duplicate
anything; handle empty chests.

## The arena checks INVARIANTS (create_sort_sim)

Per chest, `turtle_sim` checks:
- **conservation** — each item's total count is unchanged.
- **consolidation** — each item occupies exactly `ceil(count/64)` slots (partial
  stacks merged).
- **sorted** — slot item names are non-decreasing.

You don't compute the answer; you satisfy these properties for every chest.

## The algorithm (per chest, in place)

The engine's `suck*` merges same-name items into stacks in your inventory, and
`drop*` appends one slot per call to the chest. So: **drain, then drop back in
name order** and you get consolidation + sorting for free.

```lua
local function sortChest(d)                 -- d = { insp=, suck=, drop= }
  while d.suck() do end                     -- drain chest; inventory auto-merges to minimal stacks
  local names, seen = {}, {}
  for s = 1, 16 do
    local it = turtle.getItemDetail(s)
    if it and not seen[it.name] then seen[it.name] = true; names[#names+1] = it.name end
  end
  table.sort(names)                          -- lexicographic by item id
  for _, name in ipairs(names) do            -- drop back grouped + ordered
    for s = 1, 16 do
      local it = turtle.getItemDetail(s)
      if it and it.name == name then
        turtle.select(s)
        while turtle.getItemCount(s) > 0 do if not d.drop() then break end end
      end
    end
  end
end
```

Drive it over each adjacent direction, only if a chest is there:

```lua
local DIRS = {
  { insp = turtle.inspectUp,   suck = turtle.suckUp,   drop = turtle.dropUp },
  { insp = turtle.inspectDown, suck = turtle.suckDown, drop = turtle.dropDown },
  { insp = turtle.inspect,     suck = turtle.suck,     drop = turtle.drop },   -- front
}
for _, d in ipairs(DIRS) do
  local ok, data = d.insp()
  if ok and data and data.name == 'minecraft:chest' then sortChest(d) end
end
```

## Why this satisfies each invariant

- **conservation**: you drain the whole chest and drop every item back into the
  same chest.
- **consolidation**: `suck*`/`addItem` fills existing same-name stacks to 64
  before opening a new slot, so the inventory holds `ceil(count/64)` stacks per
  item; dropping each slot reproduces that in the chest.
- **sorted**: you drop names in `table.sort` order.

## Gotchas

| symptom | cause | fix |
|---|---|---|
| items mixed between chests | inventory not empty before next chest | drop ALL back per chest (the loop does) before moving on |
| "sorted" fails | dropped before ordering | collect + `table.sort` names, then drop in that order |
| consolidation fails | dropped partial stacks separately | let `suck*` merge first; drop whole slots (`d.drop()` with no count) |
| empty chest crashes | assumed items present | `while d.suck() do end` + empty name list is a no-op — safe |
| never terminates | a loop with no progress | every loop advances (suck returns false when empty; slots decrease) |

Front chest is reached without turning when the turtle faces it. Only `up`,
`down`, `front` are checked by the current arena; extend `DIRS` with turns
(`turnRight` then front) to cover all four sides.
