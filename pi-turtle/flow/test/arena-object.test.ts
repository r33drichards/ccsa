import test from 'node:test';
import assert from 'node:assert/strict';

import { envToWorldLua, envTurtles, zEnv } from '../arena-object.ts';
import { validatorFromWorkCode } from '../sim.ts';

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

test('multi-turtle environments share a named craftos world', () => {
  const env = zEnv.parse({
    turtles: [
      { label: 'sorter', start: { x: 5, y: 64, z: 5, facing: 'south', fuel: 100 } },
      { label: 'receiver', start: { x: 5, y: 64, z: 6, facing: 'north', fuel: 100 }, program: 'sleep(2) done()' },
    ],
    chests: { '5,63,5': [{ name: 'minecraft:gold_ingot', count: 9 }] },
    test: "sim.assertEq(#sim.chest(5,63,5), 0, 'shared chest')",
  });

  assert.equal(envTurtles(env).length, 2);
  const code = validatorFromWorkCode([env]);
  assert.ok(code.includes('const worlds ='));
  assert.ok(code.includes('"world":"env_0_shared"'));
  assert.ok(code.includes('sleep(2) done()'));
  assert.ok(code.includes('craftos({ nodes, worlds })'));
});

test('helper nodes may opt into the environment shared world', () => {
  const env = zEnv.parse({
    start: { x: 1, y: 2, z: 3, facing: 'east', fuel: 20 },
    nodes: [{ world: 'shared', start: { x: 2, y: 2, z: 3, facing: 'west', fuel: 20 }, program: 'done()' }],
    test: "sim.assertTrue(true, 'ok')",
  });
  const code = validatorFromWorkCode([env]);
  assert.ok(code.includes('"world":"env_0_shared"'));
});
