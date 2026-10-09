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
// Tests about dash feel get plenty of charges; the charge rules have their own tests.
const charged = (s) => { s.player.charges = 999; return s; };
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
  const s = charged(createState(open));
  run(s, { x: 1, y: 0 }, P.maxSpeed / P.accel - STEP);
  assert.ok(speed(s) < P.maxSpeed, 'not yet at top speed one step early');
  run(s, { x: 1, y: 0 }, STEP * 2);
  assert.ok(Math.abs(speed(s) - P.maxSpeed) < 1e-9);
});

test('stops within maxSpeed/decel seconds of release', () => {
  const s = charged(createState(open));
  run(s, { x: 0, y: 1 }, 0.5);
  run(s, {}, P.maxSpeed / P.decel + STEP);
  assert.equal(speed(s), 0);
});

test('dash covers dashSpeed * dashDuration and carries top speed out', () => {
  const s = charged(createState(open));
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
  const s = charged(createState(open));
  step(s, { x: 1, y: 0, dash: true });
  assert.ok(s.player.dashTime > 0);
  run(s, { x: 1, y: 0 }, P.dashCooldown - P.dashBuffer / 2);
  step(s, { x: -1, y: 0, dash: true }); // pressed early, inside buffer window
  assert.equal(s.player.dashTime, 0, 'still on cooldown');
  run(s, { x: -1, y: 0 }, P.dashBuffer);
  assert.ok(s.player.dashCooldown > 0 && s.player.dashCooldown < P.dashCooldown, 'buffered dash fired');
});

test('a press outside the buffer window is dropped', () => {
  const s = charged(createState(open));
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
  const s = charged(createState(open));
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
    const s = charged(createState(LEVELS[0]));
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
  const s = charged(createState(open));
  step(s, { x: 1, y: 0, dash: true });
  assert.ok(Math.abs(s.player.heat - P.dashHeat) < 1e-9);
  run(s, {}, 0.5);
  assert.ok(Math.abs(s.player.heat - (P.dashHeat - P.heatCool * 0.5)) < 1e-6);
  let peak = 0;
  for (let i = 0; i < 6; i++) {
    step(s, { dash: true }); peak = Math.max(peak, s.player.heat);
    run(s, {}, P.dashCooldown + STEP);
  }
  assert.equal(peak, 1, 'reaches the cap');
});

test('overheat: hitting full heat blocks dashing and slows you until it cools', () => {
  const s = charged(createState(open));
  let dashes = 0;
  while (!s.player.overheated && dashes < 20) {
    step(s, { dash: true }); dashes++;
    run(s, {}, P.dashCooldown);
  }
  assert.ok(s.player.overheated, 'overheats eventually');
  assert.ok(dashes >= 3 && dashes <= 8, `overheated after ${dashes} dashes`);
  // No dash while overheated.
  step(s, { x: 1, y: 0, dash: true });
  assert.equal(s.player.dashTime, 0);
  // Slower top speed (from the middle of the room, away from walls).
  s.player.x = 1.5; s.player.y = 4.5; s.player.vx = 0; s.player.vy = 0;
  run(s, toward(1, 0), 0.5);
  assert.ok(Math.abs(speed(s) - P.maxSpeed * P.overheatSpeed) < 1e-9, `speed ${speed(s)}`);
  // Recovers once heat has cooled to overheatRecover.
  run(s, {}, (s.player.heat - P.overheatRecover) / P.heatCool + 2 * STEP);
  assert.equal(s.player.overheated, false);
  step(s, { dash: true });
  assert.ok(s.player.dashTime > 0, 'can dash again');
});

// ---- dash charges ---------------------------------------------------------

test('charges: start with startCharges, a dash spends one, none left means no dash', () => {
  const s = createState(open);
  assert.equal(s.player.charges, P.startCharges);
  for (let i = 0; i < P.startCharges; i++) { step(s, { dash: true }); run(s, {}, P.dashCooldown + STEP); }
  assert.equal(s.player.charges, 0);
  step(s, { x: 1, y: 0, dash: true });
  assert.equal(s.player.dashTime, 0, 'no charge, no dash');
});

test('charges: each battery cell picked up adds one', () => {
  const lvl = { name: 'c', map: ['######', '#P***#', '######'] };
  const s = createState(lvl);
  run(s, toward(1, 0), 1.2);
  assert.equal(s.collected, 3);
  assert.equal(s.player.charges, P.startCharges + 3);
});

// ---- spiders ---------------------------------------------------------------

// Player at the left of a room; spiders placed relative to it.
function arena(spiders, extra = {}) {
  const s = createState({ name: 'a', map: ['############', '#..........#', '#..........#', '#.P........#', '#..........#', '#..........#', '############'] });
  s.critters = spiders.map(([x, y]) => ({
    x, y, px: x, py: y, vx: 0, vy: 0, dirX: 0, dirY: 0, timer: 99, fleeing: false,
    alive: true, mode: 'wander', cooldown: 0, partner: -1, role: 0, hitDone: false, lungeX: 0, lungeY: 0, stateTime: 0, ...extra,
  }));
  return s;
}

test('a lone spider never attacks', () => {
  const s = arena([[4, 3.5]]);
  run(s, {}, 6);
  assert.equal(s.hits, 0);
  assert.ok(s.critters.every((c) => c.mode === 'wander'));
});

test('two spiders side by side attack together and hit the player', () => {
  const s = arena([[5, 3.2], [5, 3.9]]);
  const heat0 = s.player.heat;
  while (s.hits === 0 && s.time < P.windup + P.lungeTime + 0.1) step(s, {});
  assert.ok(s.hits >= 1, 'hit');
  assert.ok(Math.abs(s.player.heat - (heat0 + P.hitHeat)) < 1e-9, `heat ${s.player.heat}`);
  assert.ok(s.player.invuln > 0);
});

test('a pair winds up before lunging (telegraph)', () => {
  const s = arena([[5, 3.2], [5, 3.9]]);
  run(s, {}, P.windup * 0.5);
  assert.ok(s.critters.every((c) => c.mode === 'windup'));
  assert.equal(s.critters[0].partner, 1);
  assert.equal(s.critters[1].partner, 0);
});

test('after attacking, the pair is thrown apart and cannot attack again right away', () => {
  const s = arena([[5, 3.2], [5, 3.9]]);
  run(s, {}, P.windup + P.lungeTime + P.thrownTime + STEP * 3);
  const [a, b] = s.critters;
  assert.ok(dist2(a, b) > P.pairRange, `apart: ${dist2(a, b).toFixed(2)}`);
  assert.ok(a.cooldown > 0 && b.cooldown > 0);
  const hits = s.hits;
  // Put them right back together next to the player: still no attack until cooldown runs out.
  a.x = 4.5; a.y = 3.2; b.x = 4.5; b.y = 3.9;
  run(s, {}, P.attackCooldown * 0.8);
  assert.equal(s.hits, hits);
});
function dist2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

test('a lone spider near the player walks to a partner', () => {
  const s = arena([[4.5, 3.5], [8.5, 3.5]]);
  const d0 = dist2(s.critters[0], s.critters[1]);
  run(s, {}, 0.5);
  assert.ok(dist2(s.critters[0], s.critters[1]) < d0 - 0.5);
});

test('dashing through a spider kills it; walking into one does not', () => {
  const walk = arena([[4.5, 3.5]], { cooldown: 99 });
  walk.critters[0].mode = 'thrown'; walk.critters[0].stateTime = 99; // keep it in place
  run(walk, toward(1, 0), 1);
  assert.equal(walk.kills, 0);

  const s = arena([[4.4, 3.5]], { cooldown: 99 });
  s.critters[0].mode = 'thrown'; s.critters[0].stateTime = 99;
  s.player.faceX = 1; s.player.faceY = 0;
  step(s, { dash: true });
  run(s, {}, P.dashDuration);
  assert.equal(s.kills, 1);
  assert.equal(s.critters[0].alive, false);
});

test('a dash kills a lunging spider instead of getting hit', () => {
  const s = arena([[5, 3.2], [5, 3.9]]);
  run(s, {}, P.windup - STEP);
  s.player.faceX = 1; s.player.faceY = 0;
  s.player.charges = 5;
  step(s, { dash: true });
  run(s, {}, P.dashDuration + STEP);
  assert.ok(s.kills >= 1, `kills ${s.kills}`);
});

test('while stunned after a hit, input is ignored', () => {
  const s = arena([[5, 3.2], [5, 3.9]]);
  while (s.hits === 0 && s.time < 2) step(s, {});
  assert.ok(s.player.stun > 0);
  const charges = s.player.charges;
  step(s, { x: -1, y: 0, dash: true });
  assert.equal(s.player.charges, charges, 'no dash while stunned');
});
