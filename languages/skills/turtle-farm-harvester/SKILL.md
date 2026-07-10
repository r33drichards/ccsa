---
name: turtle-farm-harvester
description: Use when writing or craftgen-generating a ComputerCraft (CC:Tweaked) turtle that harvests a grid farm (melons, pumpkins, crops) and sim-testing it, OR when a turtle program passes the craftos sim but crashes on the real device with "attempt to index a nil value ('sim')" / needs to fail open on a nil sim / needs GPS to self-locate.
---

# turtle-farm-harvester

## Overview

Build a CC:Tweaked harvester turtle that sweeps a grid farm, returns home, dumps
to a chest, and is idempotent from any start — validated in the craftos sim
(see [[craftos-sim]]) via craftgen's validator-in-the-loop.

**The one hard-won rule: FAIL OPEN ON A NIL `sim`.** The `sim` global
(`sim.pos`, `sim.facing`, `sim.block`, `setpos`, `periphemu`, `NET`, …) exists
ONLY inside the simulator. On a real turtle `sim == nil`, and an unguarded
`sim.pos()` throws `attempt to index a nil value ('sim')` on the FIRST line — the
program that passed every sim test dies instantly in-game. Never touch sim-only
globals unguarded.

## Fail-open pattern (position + facing)

```lua
local START_FACING = 'south'   -- real turtle is PLACED facing this way
local px, pz, facing
if sim then                                   -- simulator only
  local p = sim.pos(); px, pz, facing = p.x, p.z, sim.facing()
else                                          -- real device: GPS self-locate
  if periphemu then periphemu.create('top','modem',NET,true) end  -- sim modem, guarded
  sleep(2)                                    -- let GPS hosts answer
  local x,_,z = gps.locate(5)
  if x then px, pz = math.floor(x+0.5), math.floor(z+0.5)
  else px, pz = HOME_X, HOME_Z end            -- fallback: assume placed at HOME
  facing = START_FACING
end
```

Every simulator-only call (`sim.*`, `setpos`, `periphemu`) must sit behind
`if sim then` / `if periphemu then`. Get real inputs from the real world: GPS for
position, a configured constant for facing (place the turtle facing that way).

## Prove it with TWO test groups (don't just fail open — validate the real path)

A program can "fail open" and still be wrong. Drive the real code path in the sim
with **two node groups that must BOTH pass** (craftgen gates on every node's
`SIM_RESULT: PASS`):

| group | how | proves |
|---|---|---|
| **sim path** | ordinary turtle nodes | harvest/nav/idempotence via `sim.pos()` |
| **nil-sim / real path** | `nil_sim: true` nodes + 4 GPS host nodes | the `sim == nil` + `gps.locate()` branch actually works |

`nil_sim: true` (craftgen node flag) prepends `local sim = nil` to the program, so
it runs exactly as on the real device — yet the `world.test` post-condition still
runs (the craftos postlude reads `_G.sim`, which a *local* shadow doesn't touch).
Add a GPS constellation so the nil-sim turtle can `gps.locate()`:

```yaml
# GPS hosts — 4 NON-COPLANAR positions around the farm
- {label: gps_h1, position: [3,70,33],  program: "periphemu.create('top','modem',NET,true) shell.run('gps','host',3,70,33)"}
- {label: gps_h2, position: [13,70,33], program: "periphemu.create('top','modem',NET,true) shell.run('gps','host',13,70,33)"}
- {label: gps_h3, position: [3,70,53],  program: "periphemu.create('top','modem',NET,true) shell.run('gps','host',3,70,53)"}
- {label: gps_h4, position: [8,95,43],  program: "periphemu.create('top','modem',NET,true) shell.run('gps','host',8,95,43)"}
# real-path turtle: sim nil'd, boots facing south, GPS-locatable via position:
- label: real_from_middle
  collect: true
  nil_sim: true
  position: [8,58,43]           # turtle's GPS location
  program: "@file:melon.lua"
  worlds:
    farm: |                     # node start.facing MUST match START_FACING
    return { start={x=8,y=58,z=43,facing='south',fuel=20000}, chests={['13,59,33']={}},
             generate=..., test=... }
```

A working stationary turtle GPS-locates with just `periphemu.create` +
`gps.locate` — no movement or `setpos` needed.

## Farm sim (named Lua world = procedural generate + postcondition)

Use a Lua-string value under top-level `worlds` when functions are needed. `generate(x,y,z)` paints the
farm; `test(sim)` asserts the end state:

```lua
generate = function(x,y,z)
  if x<XMIN or x>XMAX or z<ZMIN or z>ZMAX then return nil end
  if y == 56 then return 'minecraft:dirt' end
  if y == 57 then                                   -- checkerboard plants
    if (x+z)%2==0 then return 'minecraft:melon' else return 'minecraft:melon_stem' end
  end
  return nil                                        -- y=58 = air (turtle plane)
end
```

Digging (`digDown`) collects the block as an item and leaves air (`override=false`),
so a second sweep harvests 0 — the natural loop terminator.

## Harvesting recipe (constants + geometry)

- **Work ONE plane above the plants** (`y = plant_y + 1`); the only vertical move
  allowed is `turtle.digDown()` to grab the melon below (it doesn't move you).
- **Boustrophedon (snake) sweep** every square; `inspectDown()` → if
  `'minecraft:melon'`, `digDown()`. This handles the checkerboard automatically —
  no parity math needed, robust to partial growth.
- **Track your own (x, z, facing)** by dead reckoning. Facing convention MUST match
  the engine: `north=-Z, south=+Z, east=+X, west=-X`; `turnRight` is clockwise
  (`north→east→south→west`). See `harvester.lua` for a complete, sim-validated
  program.
- **Home + chest**: return to HOME, loop 16 slots `select` + `dropUp` into the chest
  above (retry on fail), refuel if low, repeat until a sweep harvests 0. Always end
  at HOME so `assertPos` and idempotence hold.
- **Idempotence test**: several sim nodes sharing one `@file` at different starts.

## Common mistakes

| symptom | cause | fix |
|---|---|---|
| `attempt to index a nil value ('sim')` in-game | used `sim.*` unguarded | guard with `if sim then … else <gps/config> end` |
| passes sim, wrong moves on real | facing tracking ≠ engine convention | `north=-Z … turnRight clockwise` |
| `gps.locate()` returns nil | no wireless modem / hosts / coplanar hosts | attach ender modem; 4 NON-coplanar GPS hosts in range |
| nav goes wrong from GPS boot | assumed facing but placed differently | place turtle facing `START_FACING` (south) |
| second run re-digs / never ends | didn't stop on empty sweep | break when a full sweep harvests 0 |
| `[[ ... ]]` written as program | Lua long-string used inside the JS `fs.writeFile` | write the Lua with a JS string, not `[[]]` |

## Run it

```bash
uv run craftgen.py examples/melon-farm.yaml --max-steps 35   # two-group spec
```

On the real turtle: attach a wireless/ender modem, ensure a GPS constellation is
reachable, place it facing south in the work plane, then `wget` the program from
the (unpinned) raw gist URL and run.
