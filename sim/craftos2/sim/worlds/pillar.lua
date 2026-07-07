-- A 4-block stone column over bedrock. Turtle sits on top.
-- Exercises: digDown, down, detectDown, fuel, inventory, unbreakable, asserts.
return {
  start = { x = 0, y = 64, z = 0, facing = "south", fuel = 100 },
  blocks = {
    ["0,63,0"] = "minecraft:stone",
    ["0,62,0"] = "minecraft:stone",
    ["0,61,0"] = "minecraft:stone",
    ["0,60,0"] = "minecraft:stone",
    ["0,59,0"] = "minecraft:bedrock",
  },
  -- Runs after the program. Verifies the turtle mined the whole column,
  -- stopped on bedrock, kept the stone, and spent the right amount of fuel.
  test = function(sim)
    sim.assertPos(0, 60, 0, "stopped on top of bedrock")
    sim.assertFacing("south", "never turned")
    sim.assertItem(1, "minecraft:stone", 4, "collected 4 stone")
    sim.assertBlock(0, 59, 0, "minecraft:bedrock", "bedrock untouched")
    sim.assertBlock(0, 63, 0, nil, "top of column dug out")
    sim.assertFuel(96, "spent 4 fuel on 4 moves")
  end,
}
