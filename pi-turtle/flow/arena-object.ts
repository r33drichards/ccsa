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
export const zStart = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  facing: z.string(),
  fuel: z.number(),
  inventory: zInventory.optional().describe('Pre-filled turtle slots, e.g. { "1": { name, count } }'),
}).partial();
export const zNode = z.object({
  label: z.string().optional(),
  position: z.array(z.number()).length(3).optional().describe("[x,y,z] world position (modem/GPS distance)."),
  program: z.string().describe("Lua for this node. Injected globals: NET (this run's wireless net), emit(...), setpos(x,y,z), done(). Open a wireless modem with periphemu.create('top','modem',NET,true)."),
  world: z.string().optional().describe("Named shared world reference. Nodes without this remain plain CraftOS computers."),
  start: zStart.optional().describe("Per-turtle start override when world is set."),
});
export const zTurtle = z.object({
  label: z.string().optional(),
  start: zStart.optional(),
  program: z.string().optional().describe("Fixed Lua for a partner turtle. Omit on the first turtle to run the generated program."),
});
export const zEnv = z.object({
  name: z.string().optional(),
  start: zStart.optional(),
  turtles: z.array(zTurtle).min(1).optional().describe("Turtles sharing one physical world. Turtle 1 runs the generated program unless program is provided; partner turtles require fixed programs."),
  blocks: z.record(z.string(), z.string()).optional().describe('Map "x,y,z" -> block name; omitted cells default to air.'),
  unbreakable: z.record(z.string(), z.boolean()).optional().describe('Map of block names that cannot be dug.'),
  chests: z.record(z.string(), zChest).optional(),
  recipes: z.array(zRecipe).optional(),
  nodes: z.array(zNode).optional().describe("Extra computers or turtles to run alongside the primary turtle. A node with world:'shared' and start becomes a turtle in the environment's physical world; nodes without world are plain CraftOS computers."),
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

export function envTurtles(e: Env) {
  if (e.turtles?.length) return e.turtles;
  return [{ start: e.start }];
}

function envToYaml(e: Env, i: number): string {
  const world = `${envLabel(e, i)}_shared`;
  return `    - label: ${envLabel(e, i)}
      collect: true
      program: "@file:prog.lua"
      world: ${world}`;
}

export function arenaYaml(task: string, envs: Env[], timeoutMs = 60000): string {
  const worlds = envs.map((e, i) => `    ${envLabel(e, i)}_shared: |\n${envToWorldLua(e).split("\n").map((l) => "      " + l).join("\n")}`).join("\n");
  return `# ${task.replace(/\n/g, " ")}\ntask: ${JSON.stringify(task)}\nsim:\n  timeout_ms: ${timeoutMs}\n  worlds:\n${worlds}\n  nodes:\n${envs.map(envToYaml).join("\n")}\n`;
}
