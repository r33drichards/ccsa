-- A fuel chest in front of the turtle, cobblestone in its inventory.
-- Exercises: suck, refuel, select, turnLeft, place, chest depletion.
return {
  start = {
    x = 0, y = 64, z = 0, facing = "south", fuel = 5,
    inventory = { [1] = { name = "minecraft:cobblestone", count = 3 } },
  },
  -- Turtle faces south (+Z), so the chest at 0,64,1 is directly ahead.
  chests = {
    ["0,64,1"] = { { name = "minecraft:coal", count = 2 } },
  },
  test = function(sim)
    sim.assertFacing("north", "turned around to face away from chest")
    sim.assertFuel(165, "5 start + 2 coal * 80")
    sim.assertItem(1, "minecraft:cobblestone", 2, "placed one of three cobble")
    sim.assertBlock(0, 64, -1, "minecraft:cobblestone", "cobble placed behind")
    sim.assertTrue(#sim.chest(0, 64, 1) == 0, "fuel chest emptied")
  end,
}
