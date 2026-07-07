-- Turtle fake-world simulator engine for CraftOS-PC.
--
-- Provides a deterministic, world-backed implementation of the CC:Tweaked
-- `turtle` API plus a `sim` introspection/assertion API, so turtle programs can
-- be exercised under CraftOS-PC (which has no native turtle support / no world).
--
-- Lua 5.1 compatible (CraftOS-PC / CC:Tweaked dialect).
--
-- Usage:
--   local engine = dofile("/sim/engine.lua")
--   engine.install(worldModule)   -- defines global `turtle` and `sim`
--
-- World module contract (a .lua returning a table):
--   {
--     start = {x=0, y=64, z=0, facing="south", fuel=1000},   -- all optional
--     blocks = { ["x,y,z"] = "minecraft:stone", ... },        -- explicit cells (default air)
--     generate = function(x,y,z) return "minecraft:stone" end,-- optional procedural fallback
--     chests = { ["x,y,z"] = {"minecraft:coal", {name="minecraft:planks", count=8}} },
--     unbreakable = { ["minecraft:bedrock"] = true },         -- defaults to bedrock
--     fuelUnlimited = false,                                  -- optional
--     test = function(sim) ... end,                           -- optional post-conditions
--   }

local STACK = 64

-- Fuel values (ticks of movement) for common items.
local FUEL = {
  ["minecraft:coal"] = 80, ["minecraft:charcoal"] = 80,
  ["minecraft:coal_block"] = 800,
  ["minecraft:lava_bucket"] = 1000,
  ["minecraft:stick"] = 5,
  ["minecraft:oak_planks"] = 15, ["minecraft:planks"] = 15,
  ["minecraft:blaze_rod"] = 120,
}

local function key(x, y, z)
  return string.format("%d,%d,%d", x, y, z)
end

-- Clockwise (viewed from above): north(-Z) -> east(+X) -> south(+Z) -> west(-X)
local FACINGS = { "north", "east", "south", "west" }
local FACING_INDEX = { north = 1, east = 2, south = 3, west = 4 }
local FACING_VEC = {
  north = { x = 0, z = -1 },
  east  = { x = 1, z = 0 },
  south = { x = 0, z = 1 },
  west  = { x = -1, z = 0 },
}

local function normName(item)
  if type(item) == "string" then return { name = item, count = 1 } end
  return { name = item.name, count = item.count or 1 }
end

local function deepcopyInv(inv)
  local out = {}
  for i = 1, 16 do
    if inv[i] then out[i] = { name = inv[i].name, count = inv[i].count } end
  end
  return out
end

local M = {}

function M.install(world)
  world = world or {}
  local start = world.start or {}
  local generate = world.generate
  local unbreakable = world.unbreakable or { ["minecraft:bedrock"] = true }

  -- World state -------------------------------------------------------------
  -- overrides[key] = name (placed/changed) or false (explicitly air).
  -- Absent key => fall back to initial (world.blocks then generate).
  local overrides = {}
  local initialBlocks = world.blocks or {}

  -- Chest containers: key -> array of {name,count} slots. `chestCap[key]` is an
  -- optional max slot count (nil = unbounded, as before).
  --   plain form:  chests = { ["x,y,z"] = { "minecraft:coal", {name=,count=} } }
  --   config form: chests = { ["x,y,z"] = { items = {...}, double = "x,y,z", capacity = N } }
  -- A `double` links two adjacent blocks to ONE shared inventory (a double chest,
  -- 54 slots by default); the turtle can suck/drop from either half.
  local chests, chestCap = {}, {}
  if world.chests then
    for k, spec in pairs(world.chests) do
      local items, dbl, cap = spec, nil, nil
      if spec.items ~= nil or spec.double ~= nil or spec.capacity ~= nil then
        items, dbl, cap = spec.items or {}, spec.double, spec.capacity
      end
      local slots = {}
      for _, it in ipairs(items) do slots[#slots + 1] = normName(it) end
      chests[k] = slots
      if dbl then
        chests[dbl] = slots               -- both halves share one inventory
        cap = cap or 54
        chestCap[dbl] = cap
      end
      if cap then chestCap[k] = cap end
    end
  end

  local function initialBlock(x, y, z)
    local k = key(x, y, z)
    if chests[k] then return "minecraft:chest" end
    local b = initialBlocks[k]
    if b ~= nil then return b end
    if generate then return generate(x, y, z) end
    return nil
  end

  local function blockAt(x, y, z)
    local k = key(x, y, z)
    local o = overrides[k]
    if o ~= nil then
      if o == false then return nil end
      return o
    end
    return initialBlock(x, y, z)
  end

  -- Turtle state ------------------------------------------------------------
  local pos = { x = start.x or 0, y = start.y or 0, z = start.z or 0 }
  local facing = start.facing or "south"
  assert(FACING_INDEX[facing], "invalid start facing: " .. tostring(facing))
  local fuelUnlimited = world.fuelUnlimited or false
  local fuel = start.fuel or 1000
  local fuelLimit = start.fuelLimit or 100000

  local inv = {}          -- inv[1..16] = {name,count} or nil
  local selected = 1
  if start.inventory then
    for i = 1, 16 do
      if start.inventory[i] then inv[i] = normName(start.inventory[i]) end
    end
  end

  -- Direction helpers -------------------------------------------------------
  local function vecForward()
    local v = FACING_VEC[facing]
    return v.x, 0, v.z
  end
  local function targetCoords(dir) -- dir: "forward","up","down"
    if dir == "up" then return pos.x, pos.y + 1, pos.z end
    if dir == "down" then return pos.x, pos.y - 1, pos.z end
    local dx, _, dz = vecForward()
    return pos.x + dx, pos.y, pos.z + dz
  end

  -- Inventory helpers -------------------------------------------------------
  local function firstFreeOrStack(name)
    for i = 1, 16 do
      if inv[i] and inv[i].name == name and inv[i].count < STACK then return i end
    end
    for i = 1, 16 do
      if not inv[i] then return i end
    end
    return nil
  end

  local function addItem(name, count)
    count = count or 1
    while count > 0 do
      local slot = firstFreeOrStack(name)
      if not slot then return count end -- no room; remaining lost
      if not inv[slot] then inv[slot] = { name = name, count = 0 } end
      local space = STACK - inv[slot].count
      local put = math.min(space, count)
      inv[slot].count = inv[slot].count + put
      count = count - put
    end
    return 0
  end

  -- The turtle API ----------------------------------------------------------
  local turtle = {}

  local function tryMove(nx, ny, nz)
    if blockAt(nx, ny, nz) ~= nil then return false, "Movement obstructed" end
    if not fuelUnlimited then
      if fuel <= 0 then return false, "Out of fuel" end
      fuel = fuel - 1
    end
    pos.x, pos.y, pos.z = nx, ny, nz
    return true
  end

  function turtle.forward()
    local dx, _, dz = vecForward(); return tryMove(pos.x + dx, pos.y, pos.z + dz)
  end
  function turtle.back()
    local dx, _, dz = vecForward(); return tryMove(pos.x - dx, pos.y, pos.z - dz)
  end
  function turtle.up()    return tryMove(pos.x, pos.y + 1, pos.z) end
  function turtle.down()  return tryMove(pos.x, pos.y - 1, pos.z) end

  function turtle.turnRight()
    facing = FACINGS[(FACING_INDEX[facing] % 4) + 1]; return true
  end
  function turtle.turnLeft()
    facing = FACINGS[((FACING_INDEX[facing] + 2) % 4) + 1]; return true
  end

  local function digDir(dir)
    local x, y, z = targetCoords(dir)
    local b = blockAt(x, y, z)
    if b == nil then return false, "Nothing to dig here" end
    if unbreakable[b] then return false, "Unbreakable block detected" end
    overrides[key(x, y, z)] = false
    addItem(b, 1) -- if inventory full, the item is silently lost (as in CC)
    return true
  end
  function turtle.dig()     return digDir("forward") end
  function turtle.digUp()   return digDir("up") end
  function turtle.digDown() return digDir("down") end

  local function detectDir(dir)
    local x, y, z = targetCoords(dir); return blockAt(x, y, z) ~= nil
  end
  function turtle.detect()     return detectDir("forward") end
  function turtle.detectUp()   return detectDir("up") end
  function turtle.detectDown() return detectDir("down") end

  local function inspectDir(dir)
    local x, y, z = targetCoords(dir)
    local b = blockAt(x, y, z)
    if b == nil then return false, "No block to inspect" end
    return true, { name = b, state = {}, tags = {} }
  end
  function turtle.inspect()     return inspectDir("forward") end
  function turtle.inspectUp()   return inspectDir("up") end
  function turtle.inspectDown() return inspectDir("down") end

  local function compareDir(dir)
    local x, y, z = targetCoords(dir)
    local b = blockAt(x, y, z)
    local it = inv[selected]
    if b == nil and not it then return true end
    if b == nil or not it then return false end
    return b == it.name
  end
  function turtle.compare()     return compareDir("forward") end
  function turtle.compareUp()   return compareDir("up") end
  function turtle.compareDown() return compareDir("down") end

  local function placeDir(dir)
    local it = inv[selected]
    if not it or it.count < 1 then return false, "No items to place" end
    local x, y, z = targetCoords(dir)
    if blockAt(x, y, z) ~= nil then return false, "Cannot place block here" end
    overrides[key(x, y, z)] = it.name
    it.count = it.count - 1
    if it.count <= 0 then inv[selected] = nil end
    return true
  end
  function turtle.place()     return placeDir("forward") end
  function turtle.placeUp()   return placeDir("up") end
  function turtle.placeDown() return placeDir("down") end

  -- Inventory API
  function turtle.select(n)
    if type(n) ~= "number" or n < 1 or n > 16 then return false, "Invalid slot" end
    selected = math.floor(n); return true
  end
  function turtle.getSelectedSlot() return selected end
  function turtle.getItemCount(n)
    n = n or selected; return inv[n] and inv[n].count or 0
  end
  function turtle.getItemSpace(n)
    n = n or selected
    if not inv[n] then return STACK end
    return STACK - inv[n].count
  end
  function turtle.getItemDetail(n)
    n = n or selected
    if not inv[n] then return nil end
    return { name = inv[n].name, count = inv[n].count, damage = 0 }
  end
  function turtle.transferTo(n, count)
    if not inv[selected] then return false end
    count = count or inv[selected].count
    local moved = 0
    while moved < count and inv[selected] do
      if inv[n] and inv[n].name ~= inv[selected].name then break end
      if not inv[n] then inv[n] = { name = inv[selected].name, count = 0 } end
      if inv[n].count >= STACK then break end
      inv[n].count = inv[n].count + 1
      inv[selected].count = inv[selected].count - 1
      moved = moved + 1
      if inv[selected].count <= 0 then inv[selected] = nil end
    end
    return moved > 0
  end

  -- Fuel API
  function turtle.getFuelLevel() if fuelUnlimited then return "unlimited" end return fuel end
  function turtle.getFuelLimit() if fuelUnlimited then return "unlimited" end return fuelLimit end
  function turtle.refuel(count)
    local it = inv[selected]
    if not it or not FUEL[it.name] then return false, "Items not combustible" end
    local n = math.min(count or it.count, it.count)
    fuel = math.min(fuelLimit, fuel + n * FUEL[it.name])
    it.count = it.count - n
    if it.count <= 0 then inv[selected] = nil end
    return true
  end

  -- Chest interaction
  local function chestAt(dir)
    local x, y, z = targetCoords(dir)
    return chests[key(x, y, z)]
  end
  local function dropDir(dir, count)
    local it = inv[selected]
    if not it then return false, "No items to drop" end
    local x, y, z = targetCoords(dir)
    local k = key(x, y, z)
    local c = chests[k]
    if not c then return false, "No inventory to drop into" end
    if chestCap[k] and #c >= chestCap[k] then return false, "Chest is full" end
    local n = math.min(count or it.count, it.count)
    c[#c + 1] = { name = it.name, count = n }
    it.count = it.count - n
    if it.count <= 0 then inv[selected] = nil end
    return true
  end
  local function suckDir(dir, count)
    local c = chestAt(dir)
    if not c or #c == 0 then return false, "No items to take" end
    local slot = c[1]
    local n = math.min(count or slot.count, slot.count)
    local leftover = addItem(slot.name, n)
    slot.count = slot.count - (n - leftover)
    if slot.count <= 0 then table.remove(c, 1) end
    return (n - leftover) > 0
  end
  function turtle.drop(c)     return dropDir("forward", c) end
  function turtle.dropUp(c)   return dropDir("up", c) end
  function turtle.dropDown(c) return dropDir("down", c) end
  function turtle.suck(c)     return suckDir("forward", c) end
  function turtle.suckUp(c)   return suckDir("up", c) end
  function turtle.suckDown(c) return suckDir("down", c) end

  -- Crafting (crafty turtle) -------------------------------------------------
  -- Faithful to tweaked.cc `turtle.craft`: the crafting grid is the top-left
  -- 3x3 of the 4x4 inventory (slots 1,2,3 / 5,6,7 / 9,10,11); ALL other slots
  -- must be empty; craft(0) validates a recipe without crafting; the count is
  -- clamped to [0,64] and throwing outside it; the result lands in the selected
  -- slot (then any free slot).
  local CRAFT_GRID = { 1, 2, 3, 5, 6, 7, 9, 10, 11 }   -- row-major
  local CRAFT_OUTSIDE = { 4, 8, 12, 13, 14, 15, 16 }

  -- Recipe registry. Each recipe has an `output = {name=, count=}` plus either
  --   shapeless = { ["item"] = nSlots, ... }  -- n grid slots each holding item
  -- or
  --   shaped    = { [1..9] = "item"|false }    -- row-major over CRAFT_GRID, normalized.
  -- A built-in melon compression recipe (9 slices -> 1 block) ships so a bare
  -- turtle can be exercised; worlds may add/override via `world.recipes`.
  local recipes = {
    { output = { name = "minecraft:melon", count = 1 },
      shapeless = { ["minecraft:melon_slice"] = 9 } },
  }
  if world.recipes then
    for _, r in ipairs(world.recipes) do recipes[#recipes + 1] = r end
  end

  local function gridCells()
    local cells, byName, occupied = {}, {}, 0
    for _, s in ipairs(CRAFT_GRID) do
      local it = inv[s]
      if it and it.count > 0 then
        cells[#cells + 1] = { slot = s, name = it.name, count = it.count }
        byName[it.name] = (byName[it.name] or 0) + 1
        occupied = occupied + 1
      end
    end
    return cells, byName, occupied
  end

  local function shapelessMatch(recipe, byName, occupied)
    local sum = 0
    for name, qty in pairs(recipe.shapeless) do
      if (byName[name] or 0) ~= qty then return false end
      sum = sum + qty
    end
    return sum == occupied              -- no extra ingredients in the grid
  end

  local function shapedMatch(recipe, cells)
    -- current layout as a 3x3 (index r*3+c, r,c in 0..2) of item names
    local slotRC, idx = {}, 1
    for r = 0, 2 do for c = 0, 2 do slotRC[CRAFT_GRID[idx]] = r * 3 + c; idx = idx + 1 end end
    local cur = {}
    for _, cell in ipairs(cells) do cur[slotRC[cell.slot]] = cell.name end
    local want = {}
    for i = 1, 9 do if recipe.shaped[i] then want[i - 1] = recipe.shaped[i] end end
    local function bbox(g)
      local r0, c0, r1, c1 = 3, 3, -1, -1
      for i = 0, 8 do if g[i] then local r, c = math.floor(i / 3), i % 3
        r0 = math.min(r0, r); r1 = math.max(r1, r); c0 = math.min(c0, c); c1 = math.max(c1, c) end end
      return r0, c0, r1, c1
    end
    local ar0, ac0, ar1, ac1 = bbox(cur)
    local br0, bc0, br1, bc1 = bbox(want)
    if ar1 < 0 or br1 < 0 then return false end
    if (ar1 - ar0) ~= (br1 - br0) or (ac1 - ac0) ~= (bc1 - bc0) then return false end
    for r = 0, ar1 - ar0 do for c = 0, ac1 - ac0 do
      if cur[(ar0 + r) * 3 + (ac0 + c)] ~= want[(br0 + r) * 3 + (bc0 + c)] then return false end
    end end
    return true
  end

  local function findRecipe(cells, byName, occupied)
    if occupied == 0 then return nil end
    for _, r in ipairs(recipes) do
      if r.shapeless and shapelessMatch(r, byName, occupied) then return r end
      if r.shaped and shapedMatch(r, cells) then return r end
    end
    return nil
  end

  function turtle.craft(limit)
    if limit == nil then limit = 64 end
    if type(limit) ~= "number" then error("bad argument #1 to 'craft' (number expected, got " .. type(limit) .. ")", 2) end
    limit = math.floor(limit)
    if limit < 0 or limit > 64 then error("Crafting count " .. limit .. " out of range", 2) end
    for _, s in ipairs(CRAFT_OUTSIDE) do
      if inv[s] and inv[s].count > 0 then return false, "Items must not be placed outside the crafting grid" end
    end
    local cells, byName, occupied = gridCells()
    local recipe = findRecipe(cells, byName, occupied)
    if not recipe then return false, "No matching recipe" end
    local maxCrafts = STACK
    for _, cell in ipairs(cells) do if cell.count < maxCrafts then maxCrafts = cell.count end end
    if limit == 0 then return true end            -- validate only, no craft
    local n = math.min(maxCrafts, limit)
    if n <= 0 then return false, "No matching recipe" end
    for _, cell in ipairs(cells) do
      inv[cell.slot].count = inv[cell.slot].count - n
      if inv[cell.slot].count <= 0 then inv[cell.slot] = nil end
    end
    local out = recipe.output
    local produced = n * (out.count or 1)
    -- result lands in the selected slot first, then spills to any free/stackable slot
    if not inv[selected] or inv[selected].name == out.name then
      if not inv[selected] then inv[selected] = { name = out.name, count = 0 } end
      local put = math.min(STACK - inv[selected].count, produced)
      inv[selected].count = inv[selected].count + put
      produced = produced - put
    end
    if produced > 0 then addItem(out.name, produced) end
    return true
  end

  -- Op budget: every turtle.* call ticks a counter; exceeding the budget aborts
  -- the program. Non-yielding infinite loops in the sandbox can't be preempted by
  -- the host (the V8 execution-timeout and Lua debug hooks do NOT interrupt a hot
  -- wasm loop), and any real turtle loop calls turtle.* every iteration — so this
  -- bounds runtime deterministically and surfaces a clear "likely infinite loop"
  -- error instead of hanging. Override per-world with `op_budget`.
  local OP_BUDGET = tonumber(world.op_budget) or 2000000
  do
    local ops = 0
    for name, fn in pairs(turtle) do
      if type(fn) == "function" then
        turtle[name] = function(...)
          ops = ops + 1
          if ops > OP_BUDGET then
            error("turtle op budget exceeded (" .. OP_BUDGET ..
              "): the program made too many turtle calls without finishing — it " ..
              "likely has a loop that never terminates", 0)
          end
          return fn(...)
        end
      end
    end
  end

  turtle.native = turtle

  -- The sim introspection / assertion API -----------------------------------
  local sim = { passed = 0, failed = 0, log = {} }

  local function record(ok, msg)
    if ok then
      sim.passed = sim.passed + 1
      sim.log[#sim.log + 1] = "  ok   - " .. msg
    else
      sim.failed = sim.failed + 1
      sim.log[#sim.log + 1] = "  FAIL - " .. msg
    end
    return ok
  end

  function sim.pos() return { x = pos.x, y = pos.y, z = pos.z } end
  function sim.facing() return facing end
  function sim.fuel() if fuelUnlimited then return "unlimited" end return fuel end
  function sim.inventory() return deepcopyInv(inv) end
  function sim.selectedSlot() return selected end
  function sim.block(x, y, z) return blockAt(x, y, z) end
  -- Return a DEFENSIVE COPY of the chest's slots, never the live world table: a
  -- returned live reference let a program fake the end state (e.g.
  -- `sim.chest(x,y,z)[1] = {...}`) and pass every invariant without doing any
  -- turtle work — a false-positive verification. Mirrors sim.inventory()'s
  -- deepcopy. (github issues #1/#2)
  function sim.chest(x, y, z)
    local c = chests[key(x, y, z)]
    if c == nil then return nil end
    local out = {}
    for i = 1, #c do
      local s = c[i]
      if type(s) == "table" then
        local t = {}
        for k, v in pairs(s) do t[k] = v end
        out[i] = t
      else
        out[i] = s
      end
    end
    return out
  end
  function sim.worldDiff()
    local diff = {}
    for k in pairs(overrides) do
      local x, y, z = k:match("(-?%d+),(-?%d+),(-?%d+)")
      x, y, z = tonumber(x), tonumber(y), tonumber(z)
      local from = initialBlock(x, y, z)
      local to = blockAt(x, y, z)
      if from ~= to then
        diff[#diff + 1] = { x = x, y = y, z = z, from = from, to = to }
      end
    end
    return diff
  end

  -- Assertions (non-fatal; all run, summary reports totals).
  function sim.assertPos(x, y, z, msg)
    local ok = (pos.x == x and pos.y == y and pos.z == z)
    return record(ok, (msg or "position") ..
      string.format(" (expected %d,%d,%d got %d,%d,%d)", x, y, z, pos.x, pos.y, pos.z))
  end
  function sim.assertFacing(f, msg)
    return record(facing == f, (msg or "facing") .. " (expected " .. f .. " got " .. facing .. ")")
  end
  function sim.assertFuel(n, msg)
    local cur = sim.fuel()
    return record(cur == n, (msg or "fuel") .. " (expected " .. tostring(n) .. " got " .. tostring(cur) .. ")")
  end
  function sim.assertBlock(x, y, z, name, msg)
    local b = blockAt(x, y, z)
    return record(b == name, (msg or "block " .. key(x, y, z)) ..
      " (expected " .. tostring(name) .. " got " .. tostring(b) .. ")")
  end
  function sim.assertItem(slot, name, count, msg)
    local it = inv[slot]
    local gotName = it and it.name or nil
    local gotCount = it and it.count or 0
    local ok = (gotName == name) and (count == nil or gotCount == count)
    return record(ok, (msg or "slot " .. slot) ..
      " (expected " .. tostring(name) .. "x" .. tostring(count) ..
      " got " .. tostring(gotName) .. "x" .. tostring(gotCount) .. ")")
  end
  function sim.assertEq(a, b, msg)
    return record(a == b, (msg or "assertEq") .. " (expected " .. tostring(b) .. " got " .. tostring(a) .. ")")
  end
  function sim.assertTrue(v, msg)
    return record(v and true or false, msg or "assertTrue")
  end

  -- World post-conditions. `world.test(sim)` is an optional function that runs
  -- AFTER the program under test, for asserting final state. The standalone
  -- harness.lua calls it directly; the multi-node wasm runner (ccsim) has no
  -- postlude, so it exposes it here as `sim.runTest()` for a postlude to invoke.
  -- Errors thrown inside world.test count as one failure (matches harness.lua).
  sim.hasTest = type(world.test) == "function"
  function sim.runTest()
    if type(world.test) ~= "function" then return sim.passed, sim.failed end
    local ok, err = pcall(world.test, sim)
    if not ok then
      sim.failed = sim.failed + 1
      sim.log[#sim.log + 1] = "  FAIL - world.test error: " .. tostring(err)
    end
    return sim.passed, sim.failed
  end

  _G.turtle = turtle
  _G.sim = sim
  return turtle, sim
end

return M
