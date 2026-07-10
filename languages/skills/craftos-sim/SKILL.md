---
name: craftos-sim
description: Use when writing or running simulated multi-computer ComputerCraft (CC:Tweaked) tests — rednet/GPS networks, turtle programs, or any scenario needing several computers talking to each other — via the craftos() JS helper inside the run_js sandbox. Triggers on testing CC Lua logic without a Minecraft server, GPS trilateration, turtle navigation/fleets in a fake world, or "run this CC program in a sim".
---

# craftos-sim — unified CC simulation runtime

`craftos(spec)` boots an arbitrary set of networked CC computers and turtles in
an embedded CraftOS-PC emulator, runs each node's Lua, and returns what each node
emits. GPS, rednet protocols, and turtle fleets are all just programs you run on
it.

## How to run it (IMPORTANT — read this first)

`craftos` is a **JavaScript helper, not a separate tool**. There is NO
`run_simulation` tool and no external craftos server to call. You run a
simulation entirely from **`run_js`**:

1. Every `run_js` call is a FRESH V8 isolate — nothing loaded in a previous call
   survives. So load the languages bootstrap **and** call `craftos()` in the
   SAME `run_js` call.
2. The tool returns only what you print to **stdout** — `console.log(...)`. A
   bare `return`/expression is discarded.

```js
// one run_js call:
(0,eval)(await fs.readFile('/opt/languages/bootstrap.js', 'utf8'));
const out = await craftos({
  timeout_ms: 15000,
  nodes: [
    { label: 'c1', collect: true,
      world: { start: { x: 0, y: 0, z: 0, facing: 'south', fuel: 1000 } },
      program: "turtle.forward() emit('now at z='..sim.pos().z) done()" },
  ],
});
console.log(JSON.stringify(out, null, 2));
```

`craftos(spec)` takes the spec object described below (the JSON blocks in this
skill ARE that object — pass them as a JS value to `craftos(...)`) and returns
`{ net: N, nodes: [ {label, id, output, turtle} ] }`, where `output` is
everything that node passed to `emit()`.

TIP for iterating on a Lua program: keep the program source in a file under
`/work` (`await fs.writeFile('/work/prog.lua', src)`), then in the sim call read
it back with `program: await fs.readFile('/work/prog.lua','utf8')` so you edit
the Lua in one place across runs.

## Spec shape

```json
{ "timeout_ms": 15000,
  "nodes": [
    { "label": "host1", "position": [0,0,0],
      "program": "periphemu.create('top','modem',NET,true) shell.run('gps','host',0,0,0)" },
    { "label": "client", "position": [5,5,5], "collect": true,
      "program": "periphemu.create('top','modem',NET,true) sleep(2) local x,y,z=gps.locate(5) emit(x,y,z) done()" }
  ] }
```

## Each node's environment

Ordinary CC:Tweaked Lua, plus these injected globals:

- **`NET`** — this run's wireless-modem network id. Always open modems with
  `periphemu.create('side','modem', NET, true)` (the `true` = wireless). Every
  run gets a unique NET, so concurrent simulations are isolated and never
  cross-talk.
- **`emit(...)`** — record a tab-joined result line (returned in `output`).
- **`setpos(x,y,z)`** — move this node's wireless-modem position in the world, so
  other nodes' `gps.locate()` track it as it travels.
- **`done()`** — signal the node finished, so the runtime returns its full output
  promptly instead of waiting for `timeout_ms`. Mark the node `"collect": true`
  and call `done()` at the end of programs that emit multiple lines.

Node fields: `program` (required), `label`, `position` `[x,y,z]` (modem distance
for GPS), `collect` (wait for this node's output), and `world` (makes it a
turtle, below).

## Turtles

CraftOS-PC has no native turtle. Define each fake world once under top-level
`worlds`, then set a turtle node's `world` to that name. World values may be
JSON data objects or Lua chunks that return a table, so procedural generators and
`test(sim)` functions use a string world definition:

```json
{
  "worlds": {
    "mine": "return { blocks={['0,64,1']='minecraft:stone'}, test=function(sim) sim.assertBlock(0,64,1,nil,'mined') end }"
  },
  "nodes": [
    { "label":"rover", "world":"mine", "start":{"x":0,"y":64,"z":0,"facing":"south","fuel":100}, "program":"turtle.dig()" }
  ]
}
```

Multiple nodes referencing the same world see the same mutations and occupy the
same coordinate space.

Inside the program, `turtle.*` works (forward/back/up/down/turn*, dig*, detect*,
inspect*, place*, select/getItemDetail/transferTo, refuel, suck/drop, fuel), and
`sim.*` introspects the world. Facing: north `-Z`, south `+Z`, east `+X`, west
`-X`. To make GPS follow a moving turtle, mirror its world position with
`setpos(sim.pos().x, sim.pos().y, sim.pos().z)` after each move.

## Asserting world state after a turtle runs

The injected `sim` table lets you both **read** and **assert** the world — so a
test can prove "this block got mined", "the item ended up in slot 1", "the
turtle is back where it started", etc.

**Introspection** (read current state): `sim.pos()` → `{x,y,z}`, `sim.facing()`,
`sim.fuel()`, `sim.inventory()`, `sim.selectedSlot()`, `sim.block(x,y,z)` (block
name at a cell, or `nil` for air), `sim.chest(x,y,z)`, and `sim.worldDiff()` (the
list of `{x,y,z,from,to}` cells the program changed).

**Assertions** — non-fatal (they *all* run and are tallied, they don't abort the
program). Each records an `ok`/`FAIL` line and bumps `sim.passed` / `sim.failed`:

| assertion | checks |
|---|---|
| `sim.assertPos(x,y,z[,msg])` | turtle is at `x,y,z` |
| `sim.assertFacing(f[,msg])` | facing == `f` (`"north"`/`"east"`/`"south"`/`"west"`) |
| `sim.assertFuel(n[,msg])` | fuel level == `n` |
| `sim.assertBlock(x,y,z,name[,msg])` | block at cell == `name` (use `nil` for "was mined / air") |
| `sim.assertItem(slot,name[,count][,msg])` | slot holds `name` (and `count` if given) |
| `sim.assertEq(a,b[,msg])`, `sim.assertTrue(v[,msg])` | generic |

You can call these two ways:

1. **Inline** in the program, then `emit()` what you want to see.
2. **As a `world.test(sim)` post-condition** (recommended for pure state checks) —
   a function on the world table, run automatically **after** the program
   finishes. The runtime then emits the assertion log, a `sim: P passed, F failed`
   summary, and a final `SIM_RESULT: PASS` / `SIM_RESULT: FAIL` line, and calls
   `done()` for you — so a `world.test` node needs no manual `emit`/`done`. An
   error thrown inside `test` counts as one failure. (Put `test` in a Lua-string world definition.)

Worked example — mine the block in front and assert the world afterwards:

```json
{ "timeout_ms": 15000,
  "worlds": { "mine": "return { blocks={['0,64,1']='minecraft:stone'}, test=function(sim) sim.assertBlock(0,64,1,nil,'front block mined') sim.assertItem(1,'minecraft:stone',1,'stone collected') sim.assertPos(0,64,0,'stayed put') end }" },
  "nodes": [
    { "label": "mine", "collect": true, "world": "mine",
      "start": {"x":0,"y":64,"z":0,"facing":"south","fuel":100},
      "program": "turtle.dig()" }
  ] }
```

`mine` output — the post-condition ran after `turtle.dig()`:

```
  ok   - front block mined (expected nil got nil)
  ok   - stone collected (expected minecraft:stonex1 got minecraft:stonex1)
  ok   - stayed put (expected 0,64,0 got 0,64,0)
sim: 3 passed, 0 failed
SIM_RESULT: PASS
```

A failing check reports the mismatch and flips the result — e.g. asserting the
stone is *still* there after digging gives
`FAIL - ... (expected minecraft:stone got nil)` / `sim: 0 passed, 1 failed` /
`SIM_RESULT: FAIL`. Grep the returned `output` for `SIM_RESULT: PASS` to gate a
test.

## Canonical example — a turtle travels between GPS nodes

4 wireless GPS hosts at non-coplanar corners + a turtle that drives forward in
its fake world, syncs its modem position, and confirms its location via GPS at
each step.

```json
{ "timeout_ms": 20000,
  "worlds": { "travel": {} },
  "nodes": [
    {"label":"h1","position":[0,0,0],  "program":"periphemu.create('top','modem',NET,true) shell.run('gps','host',0,0,0)"},
    {"label":"h2","position":[20,0,0], "program":"periphemu.create('top','modem',NET,true) shell.run('gps','host',20,0,0)"},
    {"label":"h3","position":[0,20,0], "program":"periphemu.create('top','modem',NET,true) shell.run('gps','host',0,20,0)"},
    {"label":"h4","position":[0,0,20], "program":"periphemu.create('top','modem',NET,true) shell.run('gps','host',0,0,20)"},
    {"label":"rover","position":[0,0,0],"collect":true,
     "world":"travel","start":{"x":0,"y":0,"z":0,"facing":"south","fuel":1000},
     "program":"periphemu.create('top','modem',NET,true)\nsleep(2)\nfor step=1,5 do\n  turtle.forward()\n  local p=sim.pos()\n  setpos(p.x,p.y,p.z)\n  sleep(0.6)\n  local gx,gy,gz=gps.locate(5)\n  emit('step '..step..' world='..p.x..','..p.y..','..p.z..' gps='..tostring(gx)..','..tostring(gy)..','..tostring(gz)..' fuel='..turtle.getFuelLevel())\nend\ndone()"}
  ] }
```

Expected `rover` output — world position and GPS-resolved position agree as it
travels, fuel decrements:

```
step 1 world=0,0,1 gps=0,0,1 fuel=999
step 2 world=0,0,2 gps=0,0,2 fuel=998
step 3 world=0,0,3 gps=0,0,3 fuel=997
step 4 world=0,0,4 gps=0,0,4 fuel=996
step 5 world=0,0,5 gps=0,0,5 fuel=995
```

## Gotchas

- **GPS needs ≥4 hosts that are NOT coplanar** (e.g. corners `(0,0,0),(20,0,0),(0,20,0),(0,0,20)` — not all at the same `z`), or `gps.locate` returns nil.
- Open modems as **wireless**: the 4th `periphemu.create` arg must be `true`.
- Give hosts a head start; have clients `sleep(2)` before `gps.locate`.
- A node that emits multiple lines should be `"collect": true` and end with `done()`.
- After `setpos`, `sleep(~0.5)` before reading GPS so the runtime applies the move.
- Put data-only worlds directly under `worlds`; use a Lua-string world value when functions are needed.
