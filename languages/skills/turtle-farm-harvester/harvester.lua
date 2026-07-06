-- melon-farm harvester (fail-open reference: works with sim OR sim==nil via GPS)
local HOME_X, HOME_Z = 13, 33
local XMIN, XMAX = 3, 13
local ZMIN, ZMAX = 33, 53
local START_FACING = 'south'   -- on the real device the turtle is placed facing this way

local DX = { north = 0, south = 0, east = 1, west = -1 }
local DZ = { north = -1, south = 1, east = 0, west = 0 }
local RIGHT = { north = 'east', east = 'south', south = 'west', west = 'north' }

local pos_x, pos_z, facing

-- FAIL OPEN on a nil `sim`: sim.* exists only in the simulator. On the real
-- device (sim == nil) we self-locate with GPS and take facing from config.
local function init()
  if sim then
    local p = sim.pos()
    pos_x, pos_z, facing = p.x, p.z, sim.facing()
    return
  end
  -- real / nil-sim: locate via GPS (sim creates the modem with periphemu; a real
  -- turtle already has a wireless modem attached).
  if periphemu and NET then periphemu.create('top', 'modem', NET, true) end
  sleep(2) -- let the GPS hosts come up
  local x, y, z = gps.locate(3)
  if not x then error('melon: no GPS fix (need a wireless modem + GPS constellation)') end
  pos_x, pos_z = math.floor(x + 0.5), math.floor(z + 0.5)
  facing = START_FACING
end

local function turnTo(target)
  while facing ~= target do
    turtle.turnRight()
    facing = RIGHT[facing]
  end
end
local function forward()
  while not turtle.forward() do end
  pos_x = pos_x + DX[facing]
  pos_z = pos_z + DZ[facing]
end
local function moveTo(tx, tz)
  while pos_x ~= tx do
    turnTo(tx > pos_x and 'east' or 'west')
    forward()
  end
  while pos_z ~= tz do
    turnTo(tz > pos_z and 'south' or 'north')
    forward()
  end
end

local function harvestHere()
  local ok, data = turtle.inspectDown()
  if ok and data.name == 'minecraft:melon' then
    turtle.digDown()
    return 1
  end
  return 0
end

local function sweep()
  local got = 0
  moveTo(XMAX, ZMIN)
  local dir = 1
  local x = XMAX
  while x >= XMIN do
    moveTo(x, pos_z)
    local zEnd = (dir == 1) and ZMAX or ZMIN
    while true do
      got = got + harvestHere()
      if pos_z == zEnd then break end
      turnTo(dir == 1 and 'south' or 'north')
      forward()
    end
    dir = -dir
    x = x - 1
  end
  return got
end

local function depositAll()
  for s = 1, 16 do
    if turtle.getItemCount(s) > 0 then
      turtle.select(s)
      while turtle.getItemCount(s) > 0 do
        if not turtle.dropUp() then sleep(0.5) end
      end
    end
  end
  turtle.select(1)
end

local function hasSpace()
  for s = 1, 16 do
    if turtle.getItemCount(s) == 0 then return true end
  end
  return false
end
local function fuelOk()
  local f = turtle.getFuelLevel()
  return f == 'unlimited' or f >= 100
end

-- MAIN
init()
moveTo(HOME_X, HOME_Z)
while true do
  local got = sweep()
  moveTo(HOME_X, HOME_Z)
  depositAll()
  if got == 0 then break end
  if not (fuelOk() and hasSpace()) then break end
end
moveTo(HOME_X, HOME_Z)
