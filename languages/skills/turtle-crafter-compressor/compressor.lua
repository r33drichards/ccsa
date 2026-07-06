-- Stationary melon compressor — a CRAFTY turtle that never moves.
--
--   [ input chest ]   above the turtle  (minecraft:melon_slice)
--   [   turtle    ]   crafting table upgrade equipped
--   [ output chest]   below the turtle  (minecraft:melon)
--
-- Loop: drain slices from the chest above, compress 9 slices -> 1 melon block
-- via turtle.craft(), drop the blocks into the chest below, and return any
-- slices too few to fill a full 3x3 back up so the farm can re-feed them.
--
-- Uses NO `sim.*`/GPS/movement, so it is inherently fail-open: it runs the same
-- in the CraftOS sim and on a real device. To run FOREVER on a real turtle
-- (draining as the farm produces), wrap it in a re-run loop — e.g. a startup.lua
-- of:  while true do shell.run('compressor') sleep(30) end
--
-- This program drains the chest once and stops (so the sim terminates and its
-- post-condition can run); the startup wrapper is what makes it perpetual.

local SLICE = 'minecraft:melon_slice'
local BLOCK = 'minecraft:melon'
local PER   = 9                                    -- slices per block (a full 3x3)
local GRID  = { 1, 2, 3, 5, 6, 7, 9, 10, 11 }      -- the crafting grid (top-left 3x3)
local IN_GRID = {}
for _, g in ipairs(GRID) do IN_GRID[g] = true end

local function itemAt(s)
  local d = turtle.getItemDetail(s)
  if not d then return nil, 0 end
  return d.name, d.count
end

local function slicesIn(s)
  local nm, n = itemAt(s)
  return nm == SLICE and n or 0
end

local function countName(name)
  local n = 0
  for s = 1, 16 do
    local nm, c = itemAt(s)
    if nm == name then n = n + c end
  end
  return n
end

-- Pull every slice from the chest above. suckUp() grabs one source stack per
-- call and returns false once the chest can give no more (or we're full).
local function drainInput()
  while turtle.suckUp() do end
end

-- Return leftover slices (fewer than a full grid) to the input chest above.
local function returnSlices()
  for s = 1, 16 do
    if slicesIn(s) > 0 then
      turtle.select(s)
      while turtle.getItemCount(s) > 0 do
        if not turtle.dropUp() then break end       -- chest full: leave the rest
      end
    end
  end
end

-- Deposit every finished melon block into the chest below.
local function depositBlocks()
  for s = 1, 16 do
    local nm = itemAt(s)
    if nm == BLOCK then
      turtle.select(s)
      while turtle.getItemCount(s) > 0 do
        if not turtle.dropDown() then sleep(0.5) end
      end
    end
  end
end

-- Force grid slot `g` to hold EXACTLY `k` slices. Push any excess ONLY to
-- non-grid scratch slots (never to another grid cell), and pull a deficit only
-- from slots that are NOT already-finalized grid cells — so a cell, once set,
-- keeps exactly k and no cell is ever starved.
local function setCell(g, k, finalized)
  while slicesIn(g) > k do
    local moved = false
    for t = 1, 16 do
      if not IN_GRID[t] then
        local nm, n = itemAt(t)
        if nm == nil or (nm == SLICE and n < 64) then
          turtle.select(g)
          turtle.transferTo(t, slicesIn(g) - k)
          moved = true
          break
        end
      end
    end
    if not moved then                               -- scratch full: overflow back up
      turtle.select(g)
      turtle.dropUp(slicesIn(g) - k)
    end
  end
  local s = 1
  while slicesIn(g) < k and s <= 16 do
    if s ~= g and not finalized[s] and slicesIn(s) > 0 then
      turtle.select(s)
      turtle.transferTo(g, k - slicesIn(g))
    end
    s = s + 1
  end
  finalized[g] = true
end

-- One compression pass. Returns how many melon blocks it crafted (0 => stop).
local function pass()
  drainInput()
  local total = countName(SLICE)
  local k = math.min(math.floor(total / PER), 64)   -- blocks this craft can make
  if k == 0 then
    returnSlices()                                   -- not enough for a block
    return 0
  end
  local finalized = {}
  for _, g in ipairs(GRID) do setCell(g, k, finalized) end
  -- craft() requires every slot OUTSIDE the 3x3 to be empty
  for s = 1, 16 do
    if not IN_GRID[s] and slicesIn(s) > 0 then
      turtle.select(s)
      turtle.dropUp()
    end
  end
  turtle.select(1)                                   -- result lands in a freed grid slot
  if not turtle.craft() then                         -- guard: never spin on a bad layout
    returnSlices()
    return 0
  end
  depositBlocks()
  returnSlices()                                     -- leftover slices (total - 9k) back up
  return k
end

-- MAIN: drain the input chest, compressing until nothing craftable remains.
while true do
  if pass() == 0 then break end
end
