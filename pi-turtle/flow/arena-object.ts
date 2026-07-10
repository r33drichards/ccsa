// Typed arena object -> arena.yaml (craftgen sim spec). Lets an MCP client
// define ANY turtle task as structured data (world + invariant test) instead of
// writing raw YAML.
import { z } from "zod";

export const zStack = z.object({ name: z.string(), count: z.number().int().positive() });
export const zInventory = z.record(z.string(), zStack);
export const zChest = z.union([
  z.array(zStack),
  z.object({ items: z.array(zStack).default([]), double: z.string().optional(), capacity: z.number().int().optional() }),
]);
export const zRecipe = z.object({
  output: z.object({ name: z.string(), count: z.number().int().default(1) }),
  shapeless: z.record(z.string(), z.number().int()).optional(),
  shaped: z.array(z.string()).optional(),
});
// An extra sim computer the caller wires up alongside the turtle (e.g. a GPS host).
export const zNode = z.object({
  label: z.string().optional(),
  position: z.array(z.number()).length(3).optional().describe("[x,y,z] world position (modem/GPS distance)."),
  program: z.string().describe("Lua for this node. Injected globals: NET (this run's wireless net), emit(...), setpos(x,y,z), done(). Open a wireless modem with periphemu.create('top','modem',NET,true)."),
});
export const zEnv = z.object({
  name: z.string().optional(),
  start: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    facing: z.string(),
    fuel: z.number(),
    inventory: zInventory.optional().describe('Pre-filled turtle slots, e.g. { "1": { name, count } }'),
  }).partial().optional(),
  blocks: z.record(z.string(), z.string()).optional().describe('Map "x,y,z" -> block name; omitted cells default to air.'),
  unbreakable: z.record(z.string(), z.boolean()).optional().describe('Map of block names that cannot be dug.'),
  chests: z.record(z.string(), zChest).optional(),
  recipes: z.array(zRecipe).optional(),
  nodes: z.array(zNode).optional().describe("Extra computers to run alongside the turtle — YOU wire up multi-node setups like GPS (4 non-coplanar host nodes). The turtle auto-equips a wireless modem and publishes its position when `nodes` is set, so gps.locate() works from the turtle program."),
  nilSim: z.boolean().optional().describe("Run the turtle program with the `sim` global NIL'd — exercises the REAL-device path, so the program must use gps.locate()/peripherals/config, not sim.*. The invariant test still verifies the real end state. Pair with `nodes` (gps hosts) to test GPS navigation."),
  test: z.string().describe("Lua body of test(sim): invariant assertions (see tool description for the sim API, including block state/tag inspection and farming semantics such as wheat planting/harvest)."),
});
export type Env = z.infer<typeof zEnv>;

function lua(v: unknown): string {
  if (Array.isArray(v)) return "{ " + v.map(lua).join(", ") + " }";
  if (v && typeof v === "object") return "{ " + Object.entries(v as Record<string, unknown>)
    .map(([k, val]) => `['${k}'] = ${lua(val)}`).join(", ") + " }";
  if (typeof v === "string") return `'${v.replace(/'/g, "\\'")}'`;
  return String(v);
}

// The Lua chunk that `return`s the world table for one environment: start, chests,
// (optional) recipes, and the `test(sim)` post-condition. Shared by the YAML display
// (system prompt) and the validator (sim.ts builds craftos nodes from this).
export function envToWorldLua(e: Env): string {
  const s = { x: 8, y: 64, z: 8, facing: "south", fuel: 20000, ...(e.start || {}) };
  const inv = s.inventory
    ? "{ " + Object.entries(s.inventory).map(([slot, it]) => `[${Number(slot)}] = { name = '${it.name}', count = ${it.count} }`).join(", ") + " }"
    : null;
  const chests = e.chests
    ? "{ " + Object.entries(e.chests).map(([k, c]) => {
        const items = Array.isArray(c) ? c : c.items;
        const itemsLua = "{ " + items.map((it) => `{ name = '${it.name}', count = ${it.count} }`).join(", ") + " }";
        if (Array.isArray(c)) return `['${k}'] = ${itemsLua}`;
        const extra = (c.double ? `, double = '${c.double}'` : "") + (c.capacity != null ? `, capacity = ${c.capacity}` : "");
        return `['${k}'] = { items = ${itemsLua}${extra} }`;
      }).join(", ") + " }"
    : "{}";
  const recipes = e.recipes && e.recipes.length ? lua(e.recipes) : null;
  const blocks = e.blocks ? lua(e.blocks) : null;
  const unbreakable = e.unbreakable ? lua(e.unbreakable) : null;
  const networked = e.nodes && e.nodes.length ? "\n  networked = true," : "";
  return `return {
  start = { x = ${s.x}, y = ${s.y}, z = ${s.z}, facing = '${s.facing}', fuel = ${s.fuel}${inv ? `, inventory = ${inv}` : ""} },${networked}${blocks ? `\n  blocks = ${blocks},` : ""}${unbreakable ? `\n  unbreakable = ${unbreakable},` : ""}
  chests = ${chests},${recipes ? `\n  recipes = ${recipes},` : ""}
  test = function(sim)
${e.test.split("\n").map((l) => "    " + l).join("\n")}
  end,
}`;
}

export function envLabel(e: Env, i: number): string {
  return `env_${i}${e.name ? "_" + e.name.replace(/[^a-z0-9]+/gi, "_") : ""}`;
}

function envToYaml(e: Env, i: number): string {
  const worldLua = envToWorldLua(e).split("\n").map((l) => "        " + l).join("\n");
  return `    - label: ${envLabel(e, i)}
      collect: true
      program: "@file:prog.lua"
      world_lua: |
${worldLua}`;
}

export function arenaYaml(task: string, envs: Env[], timeoutMs = 60000): string {
  return `# ${task.replace(/\n/g, " ")}\ntask: ${JSON.stringify(task)}\nsim:\n  timeout_ms: ${timeoutMs}\n  nodes:\n${envs.map(envToYaml).join("\n")}\n`;
}
