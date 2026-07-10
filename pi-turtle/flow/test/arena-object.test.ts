import test from 'node:test';
import assert from 'node:assert/strict';

import { envToWorldLua, zEnv } from '../arena-object.ts';

test('zEnv accepts block-world fields and envToWorldLua emits them', () => {
  const env = zEnv.parse({
    start: {
      x: 8,
      y: 64,
      z: 8,
      facing: 'south',
      fuel: 100,
      inventory: {
        '1': { name: 'minecraft:wheat_seeds', count: 4 },
      },
    },
    blocks: {
      '8,63,10': 'minecraft:wheat',
      '8,62,10': 'minecraft:farmland',
    },
    unbreakable: {
      'minecraft:bedrock': true,
    },
    test: "sim.assertTrue(true, 'ok')",
  });

  const lua = envToWorldLua(env);
  assert.ok(lua.includes("inventory = { [1] = { name = 'minecraft:wheat_seeds', count = 4 } }"));
  assert.ok(lua.includes("blocks = { ['8,63,10'] = 'minecraft:wheat', ['8,62,10'] = 'minecraft:farmland' },"));
  assert.ok(lua.includes("unbreakable = { ['minecraft:bedrock'] = true },"));
});
