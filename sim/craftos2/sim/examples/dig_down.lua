-- Example turtle program under test: mine straight down until bedrock.
-- This is ordinary CC:Tweaked turtle code -- no knowledge of the simulator.
local depth = 0
while turtle.detectDown() do
  if not turtle.digDown() then
    -- digDown returns false on unbreakable blocks (bedrock): we're done.
    break
  end
  if not turtle.down() then break end
  depth = depth + 1
end
print("mined " .. depth .. " blocks, fuel left = " .. turtle.getFuelLevel())
