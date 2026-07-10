// Deterministic arena (spec.yaml) generators — the same invariant arenas the pi
// extension builds, ported standalone so the Temporal activities don't depend on pi.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");

export type Params = {
  task: "compress" | "sort";
  inputItem?: string;
  outputItem?: string;
  perCraft?: number;
  inputAbove?: boolean;
};

type Stack = [string, number];
const luaStacks = (s: Stack[]) => s.map(([n, c]) => `{ name = '${n}', count = ${c} }`).join(", ");

function compressStacks(item: string, n: number, mode: "normal" | "scatter"): string {
  const parts: string[] = []; let r = n, ci = 0;
  const chunks = [3, 7, 1, 11, 5, 9, 13, 2];
  while (r > 0) { const c = Math.min(mode === "scatter" ? chunks[ci++ % chunks.length] : 64, r); parts.push(`{ name = '${item}', count = ${c} }`); r -= c; }
  return parts.join(", ");
}

export function genCompressArena(p: Params): string {
  const inItem = p.inputItem || "minecraft:melon_slice";
  const outItem = p.outputItem || "minecraft:melon";
  const per = p.perCraft || 9;
  const above = p.inputAbove !== false;
  const inC = above ? [8, 65, 8] : [8, 63, 8], outC = above ? [8, 63, 8] : [8, 65, 8];
  const inKey = inC.join(","), outKey = outC.join(","), inCS = inC.join(", "), outCS = outC.join(", ");
  const envs: [number, "normal" | "scatter"][] = [
    [0, "normal"], [per - 1, "normal"], [per, "normal"], [per + 1, "normal"],
    [5 * per, "normal"], [7 * per + Math.max(1, per - 2), "normal"], [30 * per + 4, "normal"], [11 * per + 5, "scatter"],
  ];
  const entry = (i: number, N: number, mode: "normal" | "scatter") => ({ world: `    env_${i}_world: |
      local N = ${N}
        return {
          start = { x = 8, y = 64, z = 8, facing = 'south', fuel = 20000 },
          recipes = { { output = { name = '${outItem}', count = 1 }, shapeless = { ['${inItem}'] = ${per} } } },
          chests = { ['${inKey}'] = { ${compressStacks(inItem, N, mode)} }, ['${outKey}'] = {} },
          test = function(sim)
            local P = ${per}
            local function count(x,y,z,name) local ch,t=sim.chest(x,y,z),0 if ch then for _,it in ipairs(ch) do if it.name==name then t=t+it.count end end end return t end
            local function others(x,y,z,keep) local ch,t=sim.chest(x,y,z),0 if ch then for _,it in ipairs(ch) do if it.name~=keep then t=t+it.count end end end return t end
            local out = count(${outCS}, '${outItem}')
            local left = count(${inCS}, '${inItem}')
            local inv, held, heldIn = sim.inventory(), 0, 0
            for k=1,16 do if inv[k] then held=held+inv[k].count if inv[k].name=='${inItem}' then heldIn=heldIn+inv[k].count end end end
            sim.assertEq(out*P + left + heldIn, N, 'conservation')
            sim.assertTrue(left < P, 'maximality: a full batch was left uncrafted')
            sim.assertEq(held, 0, 'terminal: inventory emptied')
            sim.assertEq(others(${outCS}, '${outItem}'), 0, 'purity: output chest')
            sim.assertEq(others(${inCS}, '${inItem}'), 0, 'purity: input chest')
          end,
        }`, node: `    - label: env_${i}
      collect: true
      program: "@file:prog.lua"
      world: env_${i}_world
      start: { x: 8, y: 64, z: 8, facing: south, fuel: 20000 }` });
  const entries = envs.map(([N, m], i) => entry(i + 1, N, m));
  return `# compression arena: ${inItem} -> ${outItem} (${per} -> 1)
task: Compression turtle ${inItem} -> ${outItem} (${per} -> 1). Input chest ${above ? "ABOVE" : "BELOW"}; craft the product to the other side; return leftover (< ${per}) to the input chest.
sim:
  timeout_ms: 60000
  worlds:
${entries.map((e) => e.world).join("\n")}
  nodes:
${entries.map((e) => e.node).join("\n")}
`;
}

type SortChest = Stack[] | { stacks: Stack[]; double: string };
export function genSortArena(): string {
  const DIRS: Record<string, number[]> = { up: [8, 65, 8], down: [8, 63, 8], front: [8, 64, 9] };
  const merged = (c: SortChest) => { const m: Record<string, number> = {}; for (const [n, x] of (Array.isArray(c) ? c : c.stacks)) m[n] = (m[n] || 0) + x; return m; };
  const luaMap = (m: Record<string, number>) => "{ " + Object.entries(m).map(([n, c]) => `['${n}'] = ${c}`).join(", ") + " }";
  const chestLua = (d: string, c: SortChest) => {
    const at = DIRS[d].join(",");
    return Array.isArray(c) ? `['${at}'] = { ${luaStacks(c)} }` : `['${at}'] = { items = { ${luaStacks(c.stacks)} }, double = '${c.double}' }`;
  };
  const envs: Record<string, SortChest>[] = [
    { up: [["minecraft:cobblestone", 30], ["minecraft:dirt", 10], ["minecraft:cobblestone", 40], ["minecraft:dirt", 25]],
      down: [["minecraft:oak_log", 5], ["minecraft:coal", 12], ["minecraft:oak_log", 20], ["minecraft:coal", 50], ["minecraft:oak_log", 40]],
      front: [["minecraft:iron_ingot", 3], ["minecraft:dirt", 60], ["minecraft:iron_ingot", 8], ["minecraft:dirt", 10]] },
    { up: [["minecraft:dirt", 64], ["minecraft:dirt", 64], ["minecraft:dirt", 30]],
      down: [["minecraft:coal", 1], ["minecraft:iron_ingot", 1], ["minecraft:cobblestone", 1], ["minecraft:oak_log", 1]],
      front: [] },
    { up: [["minecraft:dirt", 20], ["minecraft:dirt", 40]], down: [],
      front: { double: "8,64,10", stacks: [["minecraft:cobblestone", 40], ["minecraft:dirt", 15], ["minecraft:cobblestone", 64], ["minecraft:coal", 30], ["minecraft:dirt", 25], ["minecraft:cobblestone", 30], ["minecraft:coal", 12], ["minecraft:dirt", 50], ["minecraft:cobblestone", 20]] } },
  ];
  const entry = (i: number, env: Record<string, SortChest>) => ({ world: `    sort_env_${i}_world: |
      return {
          start = { x = 8, y = 64, z = 8, facing = 'south', fuel = 20000 },
          chests = { ${Object.entries(env).map(([d, c]) => chestLua(d, c)).join(", ")} },
          test = function(sim)
            local function check(x, y, z, expected)
              local ch = sim.chest(x, y, z)
              local counts, slots, sorted, prev = {}, {}, true, nil
              if ch then for _, it in ipairs(ch) do
                counts[it.name] = (counts[it.name] or 0) + it.count
                slots[it.name] = (slots[it.name] or 0) + 1
                if prev and it.name < prev then sorted = false end
                prev = it.name
              end end
              for name, c in pairs(expected) do
                sim.assertEq(counts[name] or 0, c, name .. ' preserved')
                sim.assertEq(slots[name] or 0, math.ceil(c / 64), name .. ' consolidated')
              end
              for name, c in pairs(counts) do sim.assertEq(expected[name] or 0, c, 'no stray ' .. name) end
              sim.assertTrue(sorted, 'sorted by name @' .. x .. ',' .. y .. ',' .. z)
            end
${Object.entries(env).map(([d, c]) => `            check(${DIRS[d].join(", ")}, ${luaMap(merged(c))})`).join("\n")}
          end,
        }`, node: `    - label: sort_env_${i}
      collect: true
      program: "@file:prog.lua"
      world: sort_env_${i}_world
      start: { x: 8, y: 64, z: 8, facing: south, fuel: 20000 }` });
  const entries = envs.map((env, i) => entry(i + 1, env));
  return `# sort arena: consolidate + name-sort each adjacent chest in place (incl. a double chest)
task: In-place item sorter for adjacent chests (up, down, front). Consolidate same items into minimal stacks and order slots by item name; do not move items between chests.
sim:
  timeout_ms: 60000
  worlds:
${entries.map((e) => e.world).join("\n")}
  nodes:
${entries.map((e) => e.node).join("\n")}
`;
}

export function buildArena(p: Params): { yaml: string; skill: string } {
  if (p.task === "sort") return { yaml: genSortArena(), skill: readSkill("turtle-sorter") };
  return { yaml: genCompressArena(p), skill: readSkill("turtle-crafter-compressor") };
}

function readSkill(name: string): string {
  const p = join(REPO, "languages", "skills", name, "SKILL.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
