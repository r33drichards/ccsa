-- Example: pull fuel from the chest ahead, refuel, then wall off behind us.
turtle.suck() -- take the coal stack from the chest in front

-- find the coal and burn it
for i = 1, 16 do
  local d = turtle.getItemDetail(i)
  if d and d.name == "minecraft:coal" then
    turtle.select(i)
    turtle.refuel()
    break
  end
end

turtle.select(1)                 -- cobblestone
turtle.turnLeft(); turtle.turnLeft()  -- face the opposite direction
turtle.place()                   -- place a block where we came from
print("refueled to " .. turtle.getFuelLevel())
