---
name: turtle-crafter-compressor
description: Use when writing or craftgen-generating a STATIONARY CC:Tweaked (CC:Tweaked) CRAFTY turtle that compresses/crafts items from an input chest and deposits the result in an output chest (e.g. 9 melon slices -> 1 melon block), and sim-testing it — OR when the craftos sim lacks turtle.craft and you need to add a faithful crafting recipe to the engine.
---

# turtle-crafter-compressor

## Overview

Build a CC:Tweaked **crafty** turtle that stays put, pulls items from the chest
above, compresses them with `turtle.craft()`, and drops the product into the
chest below — validated in the craftos sim (see [[craftos-sim]]) via craftgen's
validator-in-the-loop, exactly like [[turtle-farm-harvester]].

```
  [ input chest  ]  above   (minecraft:melon_slice)
  [    turtle     ]  crafting-table upgrade equipped
  [ output chest  ]  below   (minecraft:melon block)
```

Unlike the harvester, this turtle **never moves** — so it needs no position, no
facing, and **no `sim.*`/GPS at all**. That makes it inherently fail-open: the
program runs identically in the sim and on the real device. (The one hard rule of
[[turtle-farm-harvester]] — *never touch a nil `sim` unguarded* — is satisfied
here by simply never referencing `sim`.)

## The sim has no `turtle.craft` — you add it to the engine

The craftos engine (`languages/engines/craftos-engine.lua`) ships movement,
dig/place, inspect, suck/drop and fuel, but **no crafting**. A crafty turtle
can't be validated until you add `turtle.craft` to the engine and rebuild the
bundle. The build path (no wasm rebuild — the turtle engine is *plain Lua*
injected into the emulator's MEMFS, NOT compiled into `craftos.wasm`):

```bash
# 1. edit languages/engines/craftos-engine.lua  (add turtle.craft + recipes)
cp languages/engines/craftos-engine.lua languages/vendor/craftos-engine.lua
node languages/build-bootstrap.mjs             # regenerates languages/bootstrap.js
```

`build-bootstrap.mjs` inlines `vendor/craftos-engine.lua` into `bootstrap.js`
(`__LANG.sources.craftos_engine`); craftgen seeds that bootstrap into the sandbox
`/work`, and the craftos helper writes the engine into MEMFS before each turtle
node runs. Forget the `cp` + rebuild and the sim keeps using the OLD engine.

### Make `turtle.craft` faithful to upstream (tweaked.cc)

Match the real contract (`turtle.md` / tweaked.cc), or your program passes the
sim and misbehaves in-game:

| rule | detail |
|---|---|
| grid = top-left 3×3 | slots **{1,2,3,5,6,7,9,10,11}** (row-major), NOT all 16 |
| outside must be empty | slots {4,8,12,13,14,15,16} must be empty or craft returns `false` |
| `craft(0)` validates | returns whether a recipe matches, crafts nothing |
| clamp + throw | default limit 64; **throws** if `limit < 0` or `> 64` |
| result placement | lands in the selected slot first, then spills to free slots |
| count | crafts `min(limit, min stack over occupied grid slots)` times |

Recipes: a small registry keyed by `output` + `shapeless`/`shaped`. Ship a
built-in melon compression (`{shapeless={['minecraft:melon_slice']=9}}` →
`minecraft:melon`) and let a world add more via `world.recipes`. Shapeless =
multiset of occupied grid slots matches exactly; shaped = normalized bounding-box
compare so a 2×1 recipe (planks→sticks) matches anywhere in the grid.

## The compression program (see `compressor.lua`)

The engine's `suck` fills from slot 1 up (not the selected slot), so you can't
load grid cells by `select`+`suck`. Instead: **drain, then arrange.**

1. `while turtle.suckUp() do end` — drain the input chest into the inventory.
2. `k = min(floor(total_slices / 9), 64)` — blocks makeable in one craft.
   If `k == 0`, drop the slices back up and stop (this is the terminator).
3. `setCell(g, k)` for each of the 9 grid slots — pull/push slices until each
   holds **exactly `k`**; drop any non-grid slices back up (craft needs the
   outside empty).
4. `turtle.select(1); turtle.craft()` — output lands in the freed grid slot 1.
5. `dropDown` every `minecraft:melon` block into the output chest; `dropUp` any
   leftover slices (`total − 9k`) back into the input chest.
6. Loop until a pass makes 0 blocks.

**Termination vs. "runs forever":** the program *drains once and exits* so the
sim terminates and its `test(sim)` post-condition runs (an infinite `while true`
would hit the node timeout and never validate). To run perpetually on the real
turtle, wrap it — `startup.lua`:

```lua
while true do shell.run('compressor') sleep(30) end
```

## Prove it with TWO test groups (same discipline as the harvester)

craftgen gates on every node's `SIM_RESULT: PASS`. Use both:

| group | how | proves |
|---|---|---|
| **sim path** | ordinary turtle nodes | drain→compress→deposit + leftover handling |
| **nil-sim / real path** | `nil_sim: true` node | the program never touches a nil `sim` |

No GPS constellation is needed (the turtle is stationary and never calls
`gps.locate`). Post-condition arithmetic for `N` input slices:

```lua
sim.assertEq(blocksIn(lower), math.floor(N / 9), 'blocks deposited')
sim.assertEq(slicesIn(upper), N % 9,            'leftover slices returned')
```

Pick `N` values that exercise both the exact (`N=63` → 7,0) and remainder
(`N=140` → 15,5 / `N=200` → 22,2) cases; feed multi-stack chests
(`{64,64,12}`) so you also exercise multi-slot draining.

## Run it

```bash
uv run craftgen.py examples/melon-compressor.yaml --max-steps 30
```

On the real turtle: equip a crafting-table upgrade, place it between the two
chests (input above, output below), ensure the compression recipe exists on the
server, then `wget` the program and run it (or drop it in `startup.lua` to loop).

## Common mistakes

| symptom | cause | fix |
|---|---|---|
| `attempt to call nil ('craft')` in sim | engine not rebuilt | `cp` engine→vendor, `node build-bootstrap.mjs` |
| craft returns false, "outside grid" | items in slots 4/8/12/13-16 | drop non-grid items before `craft()` |
| passes sim, no blocks in-game | recipe doesn't exist on the server | add the compression recipe (data pack/mod) |
| node never returns / times out | infinite `while true` with no exit | drain-and-exit; loop via `startup.lua` |
| only 1 grid cell filled | loaded slices with `select`+`suck` | drain first, then `setCell` to spread evenly |
