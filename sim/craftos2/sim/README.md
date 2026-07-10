# Turtle fake-world simulator

CraftOS-PC emulates a regular ComputerCraft computer but has **no native turtle
support and no Minecraft world** — the `turtle` API is `nil` at runtime. This
directory adds a deterministic, world-backed `turtle` implementation in pure Lua
so you can exercise turtle programs (movement, mining, inventory, fuel, chests)
under CraftOS-PC without a Minecraft instance.

It's a test harness, not a game: there's no rendering, no entities, no physics —
just a voxel grid the turtle digs/places/moves against, plus assertions to verify
the outcome.

## Quick start

```bash
./sim/turtle-test.sh sim/worlds/pillar.lua sim/examples/dig_down.lua
```

Exit code `0` = PASS, `1` = FAIL (CI-friendly). Output goes to stdout via a
result file, so it's clean despite the headless renderer.

- `SIM_VERBOSE=1` — also dump the raw emulator output.
- `SIM_TIMEOUT=30` — watchdog seconds (default 30).
- `CRAFTOS_ROM=<dir>` — ROM location (default `../craftos2-rom`).

Requires the `craftos` binary built in the repo root and the ROM cloned next to
the repo (see the top-level build instructions).

## How it works

`turtle-test.sh` launches `craftos --headless`, mounting:

| mount | host dir            | mode |
|-------|---------------------|------|
| `/sim`| `sim/`              | ro   |
| `/w`  | dir of world file   | ro   |
| `/p`  | dir of program file | ro   |
| `/out`| temp dir            | rw   |

It runs `harness.lua` via `--script`, which builds the world, installs the
global `turtle` and `sim` tables (`engine.lua`), `dofile`s your program, runs the
world's optional `test(sim)` post-conditions, writes `result.txt` to `/out`, and
shuts down. The wrapper parses `result.txt` for `SIM_RESULT: PASS|FAIL`.

Your program is **ordinary CC turtle code** — it has no idea it's being simulated.

## Authoring a world

A world is a `.lua` file returning a table. All fields are optional.

```lua
return {
  -- starting pose; facing is north|south|east|west (south = +Z)
  start = {
    x = 0, y = 64, z = 0, facing = "south",
    fuel = 1000, fuelLimit = 100000,
    inventory = { [1] = { name = "minecraft:cobblestone", count = 64 } },
  },

  -- explicitly placed blocks; key is "x,y,z". Anything unlisted is air.
  blocks = {
    ["0,63,0"] = "minecraft:stone",
    ["0,59,0"] = "minecraft:bedrock",
  },

  -- optional procedural fallback for cells not in `blocks`
  generate = function(x, y, z)
    if y < 60 then return "minecraft:stone" end
    return nil -- air
  end,

  -- container blocks for suck/drop; appear as "minecraft:chest" to detect/inspect
  chests = {
    ["0,64,1"] = { "minecraft:coal", { name = "minecraft:planks", count = 8 } },
  },

  -- blocks dig can't break (defaults to { ["minecraft:bedrock"] = true })
  unbreakable = { ["minecraft:bedrock"] = true },

  fuelUnlimited = false,

  -- optional metadata for inspect() fidelity
  blockStates = { ["0,63,0"] = { age = 7 } },
  blockTags = { ["minecraft:wheat"] = { ["minecraft:crops"] = true } },

  -- optional post-conditions, run after the program finishes
  test = function(sim)
    sim.assertPos(0, 60, 0)
    sim.assertItem(1, "minecraft:stone", 4)
  end,
}
```

Coordinate convention: `+Y` is up. Facing vectors — north `-Z`, south `+Z`,
east `+X`, west `-X`. `turnRight` goes N→E→S→W (clockwise from above).

## Supported `turtle` API

- **Move:** `forward back up down turnLeft turnRight` (blocked by solid blocks; costs 1 fuel)
- **Dig:** `dig digUp digDown` (drops item into inventory; bedrock/unbreakable returns false; farmland is protected from `digDown`)
- **World query:** `detect* inspect* compare*` (`inspect*` returns configured state/tags)
- **Place:** `place placeUp placeDown` (consumes selected slot into an air cell; built-in wheat seed planting is supported when a crop space sits over moist farmland)
- **Inventory:** `select getSelectedSlot getItemCount getItemSpace getItemDetail transferTo`
- **Fuel:** `getFuelLevel getFuelLimit refuel` (coal=80, charcoal=80, lava_bucket=1000, …)
- **Chests:** `drop dropUp dropDown suck suckUp suckDown` (against `chests` cells)

## The `sim` API (for assertions)

Available as a global inside your program and in `world.test`:

`sim.pos()` · `sim.facing()` · `sim.fuel()` · `sim.inventory()` ·
`sim.selectedSlot()` · `sim.block(x,y,z)` · `sim.chest(x,y,z)` ·
`sim.worldDiff()` (cells changed vs the initial world)

Assertions (non-fatal — all run, the summary reports totals; any failure ⇒ FAIL):

`sim.assertPos(x,y,z[,msg])` · `sim.assertFacing(f[,msg])` ·
`sim.assertFuel(n[,msg])` · `sim.assertBlock(x,y,z,name[,msg])` ·
`sim.assertItem(slot,name[,count][,msg])` · `sim.assertEq(a,b[,msg])` ·
`sim.assertTrue(v[,msg])`

## Limitations (by design)

- Programs run **synchronously**: no event loop, `os.pullEvent`, `parallel`,
  `sleep`-driven timing, or coroutine-based concurrency. Write straight-line
  turtle logic, or factor the logic out of the event loop to test it.
- No GPS, no real peripherals/modems, no crafting table, no entities.
- Block state/tag fidelity is world-driven via `blockStates` and `blockTags`; built-in farming semantics currently cover
  moist farmland inspection, wheat seed planting, and wheat drops from immature/mature crops.
- A full inventory silently drops dug items, mirroring CC.
- 64-item stacks; tool durability is not modeled.

## Farming regression test

Run the farming integration test with:

```bash
CRAFTOS_ROM=/path/to/craftos2-rom DYLD_LIBRARY_PATH=$PWD/craftos2-lua/src ./sim/test-farming.sh
```

### Farming semantics

The fake-world simulator now includes a small built-in farming model for wheat:

- `inspect*()` returns configured block `state` and `tags` from `blockStates` and `blockTags`.
- `minecraft:farmland` is protected from `dig*()` and returns `false, "Nothing to dig here"`.
- `turtle.place()` can plant `minecraft:wheat_seeds` into an empty crop cell in front of the turtle when the block below that cell is moist farmland.
- `turtle.placeDown()` can plant from directly above farmland into the turtle's current crop cell when the block below is moist farmland.
- Harvesting `minecraft:wheat` with `age >= 7` yields one `minecraft:wheat` plus one `minecraft:wheat_seeds`; immature wheat yields one seed.

Use `sim/test-farming.sh` as the integration regression for this behavior.
