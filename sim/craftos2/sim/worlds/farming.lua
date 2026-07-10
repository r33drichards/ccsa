return {
  start = {
    x = 0, y = 1, z = 0, facing = "south", fuel = 100,
    inventory = {
      [1] = { name = "minecraft:wheat_seeds", count = 2 },
    },
  },
  blocks = {
    ["0,0,1"] = "minecraft:farmland",
    ["-1,0,1"] = "minecraft:wheat",
  },
  blockStates = {
    ["0,0,1"] = { moisture = 7 },
    ["-1,0,1"] = { age = 7 },
  },
  blockTags = {
    ["0,0,1"] = { ["minecraft:farmland"] = true },
    ["-1,0,1"] = { ["minecraft:crops"] = true },
  },
  test = function(sim)
    sim.assertBlock(0, 0, 1, "minecraft:farmland", "farmland remains after planting")
    sim.assertBlock(0, 1, 1, "minecraft:wheat", "seeds plant a crop in front over farmland")
    sim.assertEq(sim.block(-1, 0, 1), nil, "mature crop removed after harvest")
    sim.assertItem(1, "minecraft:wheat_seeds", 2, "mature wheat returns one seed after consuming one to plant")
    sim.assertItem(2, "minecraft:wheat", 1, "mature crop yields wheat")
  end,
}
