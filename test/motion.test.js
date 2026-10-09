// Procedural motion checks: the f/zeta/r follower and the leg rig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFollower, follow, stepResponse } from '../src/dynamics.js';
import { createRig, updateRig, hipOf, legIK, RIG_DEFAULTS } from '../src/bug.js';

const peak = (ys) => Math.max(...ys);
const trough = (ys) => Math.min(...ys);

test('every preset settles on the target', () => {
  for (const [f, z, r] of [[1, 0.5, 2], [3, 1, 0], [2, 0.5, -2], [5, 2, 0], [0.5, 0.2, 1]]) {
    const ys = stepResponse(f, z, r, 20, 4000);
    assert.ok(Math.abs(ys.at(-1) - 1) < 1e-3, `f=${f} zeta=${z} r=${r} ended at ${ys.at(-1)}`);
  }
});

test('zeta >= 1 with r = 0 never overshoots', () => {
  for (const z of [1, 1.5, 3]) assert.ok(peak(stepResponse(2, z, 0, 5, 600)) <= 1 + 1e-9, `zeta=${z}`);
});

test('zeta < 1 overshoots, more for smaller zeta', () => {
  const a = peak(stepResponse(2, 0.6, 0, 5, 600));
  const b = peak(stepResponse(2, 0.2, 0, 5, 600));
  assert.ok(a > 1.01 && b > a, `peaks ${a}, ${b}`);
});

test('negative r anticipates: first moves away from the target', () => {
  assert.ok(trough(stepResponse(2, 0.5, -2, 1, 120)) < -0.05);
  assert.ok(trough(stepResponse(2, 0.5, 0, 1, 120)) >= 0);
});

test('r > 1 overshoots even when critically damped', () => {
  assert.ok(peak(stepResponse(2, 1, 2, 5, 600)) > 1.01);
});

test('stays stable when the frame is far too long for f', () => {
  // Without the k2 clamp, f = 20 Hz at 4 fps explodes within a few frames.
  const fol = createFollower(0, 20, 0.3, 2);
  let worst = 0;
  for (let i = 0; i < 200; i++) worst = Math.max(worst, Math.abs(follow(fol, 0.25, i % 40 < 20 ? 1 : -1)));
  assert.ok(worst < 5, `peak |y| = ${worst}`);
});

test('result does not depend much on frame rate', () => {
  const at = (fps) => stepResponse(2, 0.5, 1, 1, fps).at(-1);
  assert.ok(Math.abs(at(60) - at(144)) < 0.05, `${at(60)} vs ${at(144)}`);
});

test('leg IK: bones keep their length and the knee bends up', () => {
  const hip = { x: 0, y: 0, z: 0.22 };
  for (const foot of [{ x: 0.4, y: 0.1, z: 0 }, { x: -0.2, y: 0.3, z: 0.1 }, { x: 0.05, y: 0, z: 0 }]) {
    const k = legIK(hip, foot, 0.28, 0.36);
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    assert.ok(Math.abs(d(hip, k) - 0.28) < 1e-9);
    assert.ok(Math.abs(d(k, foot) - 0.36) < 1e-9);
    assert.ok(k.z > Math.max(hip.z, foot.z), `knee z ${k.z} not above hip and foot`);
  }
});

// Walk a rig along a scripted path at `speed` and collect gait statistics.
function walk(speed, seconds = 6, dt = 1 / 60) {
  const rig = createRig(0, 0, 0, RIG_DEFAULTS);
  let x = 0, y = 0, worstReach = 0, maxAir = 0, steps = 0, overReach = 0, frames = 0;
  const reach = (RIG_DEFAULTS.thigh + RIG_DEFAULTS.shin) * RIG_DEFAULTS.scale;
  for (let t = 0; t < seconds; t += dt) {
    const a = t * 0.6; // gentle curve, so turning is covered too
    const vx = Math.cos(a) * speed, vy = Math.sin(a) * speed;
    x += vx * dt; y += vy * dt;
    const before = rig.legs.map((l) => l.t);
    updateRig(rig, dt, { x, y, vx, vy });
    rig.legs.forEach((l, i) => { if (before[i] >= 1 && l.t < 1) steps++; });
    maxAir = Math.max(maxAir, rig.legs.filter((l) => l.t < 1).length);
    for (const l of rig.legs) {
      const h = hipOf(rig, l);
      const d = Math.hypot(l.foot.x - h.x, l.foot.y - h.y, l.lift - h.z);
      worstReach = Math.max(worstReach, d / reach);
      if (d > reach) overReach++;
      frames++;
    }
  }
  return { worstReach, maxAir, steps, overReachShare: overReach / frames };
}

test('gait: tripod (never more than 3 feet in the air) and it actually steps', () => {
  for (const speed of [1, 2.5, 4.5]) {
    const g = walk(speed);
    assert.ok(g.maxAir <= 3, `speed ${speed}: ${g.maxAir} feet in the air`);
    assert.ok(g.steps > speed * 6, `speed ${speed}: only ${g.steps} steps`);
  }
});

test('gait: feet stay within leg reach at walking and top speed', () => {
  for (const speed of [1, 2.5, 4.5]) {
    const g = walk(speed);
    assert.ok(g.overReachShare < 0.02, `speed ${speed}: over reach ${(g.overReachShare * 100).toFixed(1)}% of leg-frames, worst ${g.worstReach.toFixed(2)}`);
  }
});

test('standing still: feet come to rest and stop stepping', () => {
  const rig = createRig(0, 0, 0, RIG_DEFAULTS);
  for (let i = 0; i < 120; i++) updateRig(rig, 1 / 60, { x: i / 60 * 3, y: 0, vx: 3, vy: 0 });
  const x = 2;
  for (let i = 0; i < 120; i++) updateRig(rig, 1 / 60, { x, y: 0, vx: 0, vy: 0 });
  let steps = 0;
  for (let i = 0; i < 120; i++) {
    const before = rig.legs.map((l) => l.t);
    updateRig(rig, 1 / 60, { x, y: 0, vx: 0, vy: 0 });
    rig.legs.forEach((l, j) => { if (before[j] >= 1 && l.t < 1) steps++; });
  }
  assert.equal(steps, 0);
  assert.ok(rig.legs.every((l) => l.t === 1 && l.lift === 0));
});
