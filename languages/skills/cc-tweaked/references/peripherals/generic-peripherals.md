# Generic peripherals

"Generic" peripherals are method sets that CC:Tweaked attaches to *any* block that exposes the matching capability (chests, barrels, tanks, energy cells, modded blocks). A block may have several generic types at once (e.g. a chest is `"minecraft:chest"` and `"inventory"`).

Sources:
- https://tweaked.cc/generic_peripheral/inventory.html
- https://tweaked.cc/generic_peripheral/fluid_storage.html
- https://tweaked.cc/generic_peripheral/energy_storage.html

## inventory (1.94.0+)

Any block with an item inventory (chests, barrels, hoppers, furnaces, modded storage).

- `size()` → `number` — slot count.
- `list()` → `{ table|nil... }` — sparse table keyed by slot; each entry has `name`, `count`, and a possibly-nil `nbt` hash (use to distinguish otherwise-identical items). Iterate with `pairs`, not `ipairs`.
- `getItemDetail(slot)` → `table|nil` — full item info (see Item details): `displayName`, `name`, `count`, `maxCount`, optional `damage`/`maxDamage`, `tags`, `enchantments`, etc. Throws if slot out of range.
- `getItemLimit(slot)` → `number` — max items the slot holds (usually 64; barrels/caches can be more). (1.96.0+)
- `pushItems(toName, fromSlot [, limit [, toSlot]])` → `number` — move items to another inventory **on the same wired network**. `toName` is the target's network name. Returns count moved.
- `pullItems(fromName, fromSlot [, limit [, toSlot]])` → `number` — pull items from another networked inventory into this one.

```lua
local chest = peripheral.find("minecraft:chest")
for slot, item in pairs(chest.list()) do
  print(("%d x %s in slot %d"):format(item.count, item.name, slot))
end
-- move a stack to a connected barrel
chest.pushItems("minecraft:barrel_0", 1)
```

Note: turtles/computers can't `pushItems` into themselves over the network the same way; use turtle inventory methods for the turtle's own slots.

## fluid_storage

Tanks and other fluid-holding blocks.

- `tanks()` → `{ table... }` — list of tanks; each `{ name = "minecraft:water", amount = number }` (amount in mB).
- `pushFluid(toName [, limit [, fluidName]])` → `number` — move fluid to another networked fluid storage; returns mB moved.
- `pullFluid(fromName [, limit [, fluidName]])` → `number` — pull fluid from another networked storage.

## energy_storage

Blocks that store Forge Energy (FE).

- `getEnergy()` → `number` — current FE.
- `getEnergyCapacity()` → `number` — max FE.
