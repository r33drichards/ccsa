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

  -- Chest containers: key -> array of {name,count} slots.
  local chests = {}
  if world.chests then
    for k, list in pairs(world.chests) do
      local slots = {}
      for _, it in ipairs(list) do slots[#slots + 1] = normName(it) end
      chests[k] = slots
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
    local c = chestAt(dir)
    if not c then return false, "No inventory to drop into" end
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
  function sim.chest(x, y, z) return chests[key(x, y, z)] end
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
