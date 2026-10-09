// Checks the simulation against docs/SPEC.md. No renderer involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, step, DEFAULT_PARAMS, STEP, inputToWorld, worldToScreen, wallClearance,
} from '../src/sim.js';
import { LEVELS } from '../src/levels.js';

const P = DEFAULT_PARAMS;
const open = { name: 'open', map: ['#########', '#.......#', '#.......#', '#.......#', '#...P...#', '#.......#', '#.......#', '#.......#', '#########'] };

function run(state, input, seconds, params = P) {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) step(state, typeof input === 'function' ? input(i) : input, params);
  return state;
}
const speed = (s) => Math.hypot(s.player.vx, s.player.vy);
// Screen-space stick input that moves the player along world direction (wx, wy).
function toward(wx, wy) {
  const v = worldToScreen(wx, wy);
  const l = Math.hypot(v.x, v.y);
  return { x: v.x / l, y: v.y / l };
}

test('screen-mode input projects onto the same screen direction', () => {
  for (const [ix, iy] of [[1, 0], [0, -1], [1, -1], [-1, 1], [0.3, 0.8]]) {
    const w = inputToWorld(ix, iy, 'screen');
    const s = worldToScreen(w.x, w.y);
    const a = Math.atan2(s.y, s.x), b = Math.atan2(iy, ix);
    assert.ok(Math.abs(a - b) < 1e-9, `input ${ix},${iy}`);
  }
});

test('grid-mode diagonals run along tile axes', () => {
  const w = inputToWorld(1, -1, 'grid');
  assert.ok(Math.abs(w.x) < 1e-9 && w.y < 0);
});

test('reaches top speed after maxSpeed/accel seconds', () => {
  const s = createState(open);
  run(s, { x: 1, y: 0 }, P.maxSpeed / P.accel - STEP);
  assert.ok(speed(s) < P.maxSpeed, 'not yet at top speed one step early');
  run(s, { x: 1, y: 0 }, STEP * 2);
  assert.ok(Math.abs(speed(s) - P.maxSpeed) < 1e-9);
});

test('stops within maxSpeed/decel seconds of release', () => {
  const s = createState(open);
  run(s, { x: 0, y: 1 }, 0.5);
  run(s, {}, P.maxSpeed / P.decel + STEP);
  assert.equal(speed(s), 0);
});

test('dash covers dashSpeed * dashDuration and carries top speed out', () => {
  const s = createState(open);
  s.player.x = 2; s.player.y = 4.5;
  s.player.faceX = 1; s.player.faceY = 0;
  const x0 = s.player.x;
  const steps = Math.ceil(P.dashDuration / STEP - 1e-9);
  step(s, { dash: true });
  run(s, {}, (steps - 1) * STEP);
  assert.equal(s.player.dashTime, 0);
  // The last dash step is blended: the rest of it runs at top speed.
  const expected = P.dashSpeed * P.dashDuration + P.maxSpeed * (steps * STEP - P.dashDuration);
  assert.ok(Math.abs(s.player.x - x0 - expected) < 1e-9, `dashed ${s.player.x - x0}, expected ${expected}`);
  assert.ok(Math.abs(speed(s) - P.maxSpeed) < 1e-9);
});

test('cooldown blocks a second dash; the buffer fires it when ready', () => {
  const s = createState(open);
  step(s, { x: 1, y: 0, dash: true });
  assert.ok(s.player.dashTime > 0);
  run(s, { x: 1, y: 0 }, P.dashCooldown - P.dashBuffer / 2);
  step(s, { x: -1, y: 0, dash: true }); // pressed early, inside buffer window
  assert.equal(s.player.dashTime, 0, 'still on cooldown');
  run(s, { x: -1, y: 0 }, P.dashBuffer);
  assert.ok(s.player.dashCooldown > 0 && s.player.dashCooldown < P.dashCooldown, 'buffered dash fired');
});

test('a press outside the buffer window is dropped', () => {
  const s = createState(open);
  step(s, { x: 1, y: 0, dash: true });
  run(s, {}, P.dashCooldown - P.dashBuffer * 2);
  step(s, { dash: true });
  run(s, {}, P.dashBuffer * 3);
  assert.equal(s.player.dashTime, 0);
  assert.ok(s.player.dashCooldown === 0, 'no second dash started');
});

test('dash into a one-tile wall does not tunnel', () => {
  const lvl = { name: 't', map: ['#######', '#..#..#', '#P.#..#', '#..#..#', '#######'] };
  const s = createState(lvl);
  s.player.faceX = 1; s.player.faceY = 0;
  step(s, { dash: true });
  run(s, toward(1, 0), 1);
  assert.ok(s.player.x > 2.6, `reached the wall, x=${s.player.x}`);
  assert.ok(s.player.x <= 3 - P.radius + 1e-9, `stayed in front of it, x=${s.player.x}`);
  assert.ok(wallClearance(s, P.radius) > -1e-9);
});

test('slides along a wall instead of stopping', () => {
  const s = createState(open);
  s.player.x = 1.5; s.player.y = 4.5;
  // Push into the wall at x < 1 and along it (+y) at once.
  run(s, toward(-1, 1), 0.5);
  assert.ok(s.player.y > 5, `slid to y=${s.player.y}`);
  assert.ok(wallClearance(s, P.radius) > -1e-9);
});

test('fuzz: never overlaps a wall in the real level, any params preset', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (const params of [P, { ...P, dashSpeed: 30, maxSpeed: 9 }, { ...P, diagonalMode: 'grid' }]) {
    const s = createState(LEVELS[0]);
    let input = { x: 0, y: 0 };
    for (let i = 0; i < 60 * 60; i++) {
      if (i % 20 === 0) input = { x: rnd() * 2 - 1, y: rnd() * 2 - 1 };
      step(s, { ...input, dash: rnd() < 0.05 }, params);
      const c = wallClearance(s, params.radius);
      assert.ok(c > -1e-6, `overlap ${c} at tick ${i} pos ${s.player.x},${s.player.y}`);
    }
  }
});

test('collecting every shard wins and stops the timer', () => {
  const lvl = { name: 'w', map: ['#####', '#P**#', '#####'] };
  const s = createState(lvl);
  run(s, toward(1, 0), 1);
  assert.equal(s.collected, 2);
  assert.ok(s.won);
  const t = s.time;
  run(s, {}, 0.5);
  assert.equal(s.time, t);
});

test('deterministic: same inputs give the same state', () => {
  const script = (i) => ({ x: Math.sin(i / 17), y: Math.cos(i / 23), dash: i % 45 === 0 });
  const a = run(createState(LEVELS[0]), script, 10);
  const b = run(createState(LEVELS[0]), script, 10);
  assert.deepEqual([a.player.x, a.player.y, a.collected], [b.player.x, b.player.y, b.collected]);
});

test('critters never end up inside walls and the run is reproducible', () => {
  const script = (i) => ({ x: Math.sin(i / 31), y: Math.cos(i / 19), dash: i % 50 === 0 });
  const a = createState(LEVELS[0], 7);
  assert.ok(a.critters.length >= 4);
  for (let i = 0; i < 60 * 60; i++) {
    step(a, script(i), P);
    for (const c of a.critters) {
      const gap = wallClearance(a, P.critterRadius, c);
      assert.ok(gap > -1e-6, `critter overlap ${gap} at tick ${i}`);
    }
  }
  const b = run(createState(LEVELS[0], 7), script, 60);
  assert.deepEqual(a.critters.map((c) => [c.x, c.y]), b.critters.map((c) => [c.x, c.y]));
});

test('a critter runs from the player when it comes close', () => {
  const lvl = { name: 'c', map: ['##########', '#........#', '#.P..b...#', '#........#', '##########'] };
  const s = createState(lvl);
  const c = s.critters[0];
  s.player.x = c.x - P.critterFear + 0.3; s.player.y = c.y;
  const d0 = Math.hypot(c.x - s.player.x, c.y - s.player.y);
  run(s, {}, 0.5);
  assert.ok(c.fleeing);
  assert.ok(Math.hypot(c.x - s.player.x, c.y - s.player.y) > d0 + 0.5);
});

test('heat: each dash adds dashHeat, it cools at heatCool per second, capped at 1', () => {
  const s = createState(open);
  step(s, { x: 1, y: 0, dash: true });
  assert.ok(Math.abs(s.player.heat - P.dashHeat) < 1e-9);
  run(s, {}, 0.5);
  assert.ok(Math.abs(s.player.heat - (P.dashHeat - P.heatCool * 0.5)) < 1e-6);
  for (let i = 0; i < 6; i++) { step(s, { dash: true }); run(s, {}, P.dashCooldown); }
  assert.ok(s.player.heat <= 1 && s.player.heat > 0.8, `heat ${s.player.heat}`);
});
