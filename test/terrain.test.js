// Multi-level terrain: heights, ramps, stairs, cliffs, reachability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, step, DEFAULT_PARAMS as P, STEP, worldToScreen, groundLevel, edgeOpen, canPass, isSolid, wallClearance,
} from '../src/sim.js';
import { LEVELS } from '../src/levels.js';

// Ramp at x=3 rising +x from level 0 to the level-1 block at x=4..6 (rows 2-3).
// Row 3 also has a level-1 tile at x=3, beside the ramp.
const hill = {
  name: 'hill',
  map: ['##########', '#........#', '#P.......#', '#........#', '#........#', '##########'],
  heights: ['0000000000', '0000000000', '000>111000', '0001111000', '0000000000', '0000000000'],
};
const stairs = { ...hill, heights: hill.heights.map((r) => r.replace('>', 'E')) };

function toward(wx, wy) {
  const v = worldToScreen(wx, wy), l = Math.hypot(v.x, v.y);
  return { x: v.x / l, y: v.y / l };
}
function run(s, input, seconds) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) step(s, input, P);
  return s;
}
function at(s, x, y) { s.player.x = x; s.player.y = y; s.player.vx = 0; s.player.vy = 0; s.player.z = groundLevel(s.map, x, y); return s; }

test('ramps and stairs rise one level across the tile', () => {
  for (const lvl of [hill, stairs]) {
    const s = createState(lvl);
    assert.equal(groundLevel(s.map, 3.0, 2.5), 0);
    assert.ok(Math.abs(groundLevel(s.map, 3.25, 2.5) - 0.25) < 1e-6);
    assert.ok(Math.abs(groundLevel(s.map, 3.999, 2.5) - 0.999) < 1e-3);
    assert.equal(groundLevel(s.map, 5.5, 2.5), 1);
  }
});

test('walking up a ramp (and stairs) reaches the upper level, height changes smoothly', () => {
  for (const lvl of [hill, stairs]) {
    const s = at(createState(lvl), 1.5, 2.5);
    let prevZ = s.player.z, worst = 0;
    while (s.player.x < 5.2 && s.time < 3) {
      step(s, toward(1, 0), P);
      worst = Math.max(worst, Math.abs(s.player.z - prevZ));
      prevZ = s.player.z;
    }
    assert.ok(s.player.x >= 5.2, `got to x=${s.player.x.toFixed(2)}`);
    assert.equal(s.player.z, 1);
    assert.equal(s.player.air, false);
    assert.ok(worst <= P.maxSpeed * STEP + 1e-9, `height jumped by ${worst}`);
  }
});

test('and back down again', () => {
  const s = at(createState(hill), 5.5, 2.5);
  run(s, toward(-1, 0), 1.2);
  assert.ok(s.player.x < 3, `x=${s.player.x.toFixed(2)}`);
  assert.equal(s.player.z, 0);
});

test('cliffs: you cannot walk up one', () => {
  const up = at(createState(hill), 5.5, 1.5);
  run(up, toward(0, 1), 1);
  assert.ok(up.player.y <= 2 - P.radius + 1e-9, `climbed to y=${up.player.y.toFixed(2)}`);
  assert.equal(up.player.z, 0);
});

test('ledges: you can step off, fall with gravity and land on the lower floor', () => {
  const s = at(createState(hill), 5.5, 2.5);
  let maxDrop = 0, airborneSteps = 0, prevZ = s.player.z;
  for (let i = 0; i < 60; i++) {
    step(s, toward(0, -1), P);
    if (s.player.air) airborneSteps++;
    maxDrop = Math.max(maxDrop, prevZ - s.player.z);
    prevZ = s.player.z;
  }
  assert.ok(s.player.y < 2 - P.radius, `walked off to y=${s.player.y.toFixed(2)}`);
  assert.equal(s.player.z, 0);
  assert.equal(s.player.air, false);
  // Falling one level takes sqrt(2 / gravity) seconds; it is not instant.
  const fallSteps = Math.sqrt(2 / P.gravity) / STEP;
  assert.ok(airborneSteps >= fallSteps - 2, `in the air for ${airborneSteps} steps`);
  assert.ok(maxDrop < 0.5, `dropped ${maxDrop.toFixed(2)} in one step`);
  const land = s.events.find((e) => e.type === 'land');
  assert.ok(land && Math.abs(land.height - 1) < 1e-6, 'landing reported with its height');
});

test('a big fall stuns briefly; a small one does not', () => {
  const deep = { ...hill, heights: hill.heights.map((r, y) => (y === 2 || y === 3 ? r.replace(/1/g, '2') : r)) };
  // Drop 2 levels off the north edge.
  const s = at(createState(deep), 5.5, 2.5);
  let stunned = false;
  for (let i = 0; i < 60; i++) { step(s, toward(0, -1), P); stunned ||= s.player.stun > 0; }
  assert.ok(stunned, 'stunned after dropping 2 levels');
  const t = at(createState(hill), 5.5, 2.5);
  let stunned1 = false;
  for (let i = 0; i < 60; i++) { step(t, toward(0, -1), P); stunned1 ||= t.player.stun > 0; }
  assert.equal(stunned1, false);
});

test('in the air you keep your momentum and steer only a little', () => {
  const s = at(createState(hill), 5.5, 2.5);
  run(s, toward(0, -1), 0.2); // run off the edge
  while (!s.player.air && s.time < 1) step(s, toward(0, -1), P);
  assert.ok(s.player.air);
  const vy = s.player.vy;
  step(s, toward(0, 1), P); // try to turn back
  assert.ok(s.player.vy < 0, 'still moving away from the ledge');
  assert.ok(Math.abs(s.player.vy - vy) <= P.accel * P.airControl * STEP + 1e-9);
});

test('a ramp cannot be entered from the side where it is already high', () => {
  const s = at(createState(hill), 3.6, 1.5);
  run(s, toward(0, 1), 1);
  assert.ok(s.player.y <= 2 - P.radius + 1e-9, `y=${s.player.y.toFixed(2)}`);
});

test('a dash cannot go up a cliff', () => {
  const s = at(createState(hill), 5.5, 1.5);
  s.player.faceX = 0; s.player.faceY = 1;
  step(s, { dash: true }, P);
  run(s, {}, 0.5);
  assert.equal(s.player.z, 0);
  assert.ok(wallClearance(s, P.radius) > -1e-9);
});

test('batteries on another level are out of reach', () => {
  const lvl = { ...hill, map: hill.map.map((r, y) => (y === 2 ? '#P...*...#' : r)) };
  const s = at(createState(lvl), 5.5, 1.75); // right below the cell, one level down
  run(s, toward(0, 1), 0.5);
  assert.equal(s.collected, 0);
  const t = at(createState(lvl), 1.5, 2.5);
  run(t, toward(1, 0), 1.5); // up the ramp to it
  assert.equal(t.collected, 1);
});

test('arena: slopes connect a level to the one above', () => {
  const s = createState(LEVELS[0]);
  const m = s.map;
  let slopes = 0;
  for (let ty = 0; ty < m.h; ty++) {
    for (let tx = 0; tx < m.w; tx++) {
      const i = ty * m.w + tx;
      if (!m.kind[i]) continue;
      slopes++;
      const lo = [tx - m.sdx[i], ty - m.sdy[i]], hi = [tx + m.sdx[i], ty + m.sdy[i]];
      assert.ok(edgeOpen(m, tx, ty, ...lo), `slope ${tx},${ty}: low side not open`);
      assert.ok(edgeOpen(m, tx, ty, ...hi), `slope ${tx},${ty}: high side not open`);
    }
  }
  assert.ok(slopes >= 4, `only ${slopes} slope tiles`);
  const levels = new Set([...m.level].filter((v, i) => !m.kind[i] && !m.solid[i]));
  assert.ok(levels.size >= 3, `levels used: ${[...levels]}`);
});

test('arena: every battery and vent can be reached from the spawn', () => {
  const s = createState(LEVELS[0]);
  const m = s.map;
  const seen = new Set();
  const start = [Math.floor(m.spawn.x), Math.floor(m.spawn.y)];
  const queue = [start];
  seen.add(start.join());
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [x + dx, y + dy];
      if (seen.has(n.join()) || !canPass(m, x, y, ...n)) continue;
      seen.add(n.join()); queue.push(n);
    }
  }
  assert.ok(s.cocoons.length >= 3, 'cocoons placed');
  for (const c of [...s.shards, ...s.vents, ...s.cocoons]) {
    assert.ok(seen.has(`${Math.floor(c.x)},${Math.floor(c.y)}`), `unreachable at ${c.x},${c.y}`);
  }
  assert.ok(!isSolid(m, ...start));
});

test('arena: no dead ends: from every reachable tile you can get back to the spawn', () => {
  const s = createState(LEVELS[0]);
  const m = s.map;
  const key = (x, y) => `${x},${y}`;
  const start = [Math.floor(m.spawn.x), Math.floor(m.spawn.y)];
  const flood = (from, step) => {
    const seen = new Set([key(...from)]), q = [from];
    while (q.length) {
      const [x, y] = q.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = [x + dx, y + dy];
        if (!seen.has(key(...n)) && step(x, y, ...n)) { seen.add(key(...n)); q.push(n); }
      }
    }
    return seen;
  };
  const forward = flood(start, (ax, ay, bx, by) => canPass(m, ax, ay, bx, by));
  const back = flood(start, (ax, ay, bx, by) => canPass(m, bx, by, ax, ay)); // tiles that can reach the spawn
  for (const t of forward) assert.ok(back.has(t), `stuck at ${t}`);
});

test('the sprawl: a big arena with all five biomes, each with batteries', async () => {
  const { BIOMES, generateArena } = await import('../src/levels.js');
  const lvl = LEVELS[0];
  assert.ok(lvl.map.length >= 64 && lvl.map[0].length >= 64, 'way bigger than 32 x 32');
  const s = createState(lvl);
  const counts = {}, cells = {};
  const keys = Object.keys(BIOMES);
  for (let i = 0; i < s.map.w * s.map.h; i++) counts[keys[s.map.biome[i]]] = (counts[keys[s.map.biome[i]]] || 0) + 1;
  for (const c of s.shards) { const k = keys[s.map.biome[Math.floor(c.y) * s.map.w + Math.floor(c.x)]]; cells[k] = (cells[k] || 0) + 1; }
  for (const k of keys) {
    assert.ok(counts[k] > 300, `${BIOMES[k].name}: ${counts[k]} tiles`);
    assert.ok(cells[k] >= 5, `${BIOMES[k].name}: ${cells[k]} batteries`);
  }
  assert.ok(s.vents.length >= 10 && s.cocoons.length >= 8);
  // Deterministic: the same seed gives the same arena.
  assert.deepEqual(generateArena(7, 80), lvl);
});
