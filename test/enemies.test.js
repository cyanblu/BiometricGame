// Cocoon turrets, webs, spiders from cocoons, cotton stainers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, step, DEFAULT_PARAMS as P, STEP, worldToScreen, makeSpider, lineOfSight } from '../src/sim.js';

function toward(wx, wy) { const v = worldToScreen(wx, wy), l = Math.hypot(v.x, v.y); return { x: v.x / l, y: v.y / l }; }
function run(s, input, seconds) { for (let i = 0; i < Math.round(seconds / STEP); i++) step(s, typeof input === 'function' ? input(i) : input, P); return s; }
const speed = (s) => Math.hypot(s.player.vx, s.player.vy);

// Cocoon at x=8, player at x=2 on the same row; a wall can be added between.
const yard = (row3) => ({ name: 'y', map: ['############', '#..........#', '#..........#', row3, '#..........#', '#..........#', '############'] });
const open = yard('#.P.....O..#');
const walled = yard('#.P..#..O..#');

test('line of sight: walls block it', () => {
  const a = createState(open), b = createState(walled);
  assert.ok(lineOfSight(a.map, 2.5, 3.5, 8.5, 3.5, 0));
  assert.ok(!lineOfSight(b.map, 2.5, 3.5, 8.5, 3.5, 0));
});

test('a turret with line of sight turns, charges and fires a web; behind a wall it does not', () => {
  const s = createState(open);
  s.cocoons[0].reload = 0;
  let shotAt = -1;
  for (let i = 0; i < 300 && shotAt < 0; i++) { step(s, {}, P); if (s.events.some((e) => e.type === 'shoot')) shotAt = i; }
  assert.ok(shotAt >= 0, 'fired');
  assert.ok(shotAt * STEP >= P.turretCharge - STEP, `charged for ${(shotAt * STEP).toFixed(2)} s first`);
  const w = createState(walled);
  w.cocoons[0].reload = 0;
  run(w, {}, 5);
  assert.ok(!w.events.some((e) => e.type === 'shoot'));
});

test('a web hit slows the player for webDuration, then it wears off', () => {
  const s = createState(open);
  s.cocoons[0].reload = 0;
  while (s.player.webbed === 0 && s.time < 5) step(s, {}, P);
  assert.ok(s.player.webbed > 0, 'got webbed');
  run(s, toward(0, 1), 0.5);
  assert.ok(Math.abs(speed(s) - P.maxSpeed * P.webSlow) < 1e-6, `speed ${speed(s).toFixed(2)} while webbed`);
  s.cocoons[0].alive = false; // no more shots
  run(s, toward(0, 1), P.webDuration);
  assert.equal(s.player.webbed, 0);
  run(s, toward(0, -1), 0.5);
  assert.ok(Math.abs(speed(s) - P.maxSpeed) < 1e-6, 'full speed again');
});

test('a dash tears the web; webs do not stick during a dash', () => {
  const s = createState(open);
  s.player.webbed = 2;
  step(s, { x: 0, y: 1, dash: true }, P);
  assert.equal(s.player.webbed, 0);
  assert.ok(s.events.some((e) => e.type === 'webTorn'));
  const t = createState(open);
  t.cocoons[0].alive = false;
  t.webs.push({ id: 99, x: 3.2, y: 3.5, z: 0.5, vx: -6, vy: 0, travel: 0, px: 3.2, py: 3.5 });
  t.player.faceX = 1; t.player.faceY = 0;
  step(t, { dash: true }, P);
  run(t, {}, 0.1);
  assert.equal(t.player.webbed, 0);
});

test('webs stick to walls', () => {
  const s = createState(walled);
  s.webs.push({ id: 99, x: 4.5, y: 3.5, z: 0.5, vx: 6, vy: 0, travel: 0, px: 4.5, py: 3.5 });
  run(s, {}, 0.5);
  assert.equal(s.webs.length, 0);
  assert.ok(s.events.some((e) => e.type === 'webSplat'));
});

test('a cocoon takes three dash hits; each dash counts once and bounces you off; then a spider drops', () => {
  const s = createState(yard('#.P.O......#'));
  const c = s.cocoons[0];
  c.reload = 99;
  for (let hitNo = 1; hitNo <= P.cocoonHits; hitNo++) {
    s.player.x = 2.5; s.player.y = 3.5; s.player.vx = 0; s.player.vy = 0;
    s.player.faceX = 1; s.player.faceY = 0; s.player.dashCooldown = 0; s.player.heat = 0;
    step(s, { dash: true }, P);
    run(s, {}, P.dashDuration + 0.05);
    assert.equal(c.hp, P.cocoonHits - hitNo, `after dash ${hitNo}`);
    if (hitNo < P.cocoonHits) {
      assert.ok(c.alive);
      assert.ok(s.player.x < c.x - P.radius - P.cocoonRadius + 0.05, 'bounced off, not through');
    }
  }
  assert.equal(c.alive, false);
  assert.equal(s.events.filter((e) => e.type === 'cocoonHit').length, P.cocoonHits);
  const sp = s.critters.find((q) => q.type === 'spider');
  assert.ok(sp, 'spider released');
  run(s, {}, 1);
  assert.equal(sp.air, false);
  assert.equal(sp.z, 0);
  assert.ok(s.events.some((e) => e.type === 'land' && e.who === sp.id && e.height > 1));
});

test('a fast dung ball hits a cocoon once per bounce, three bounces break it', async () => {
  const B = { ...P, mech: 'ball' };
  const s = createState(yard('#.P...O....#'), 1, B);
  const c = s.cocoons[0];
  c.reload = 99;
  for (let n = 0; n < 3; n++) {
    const b = s.player.ball;
    s.player.x = 2.5; s.player.y = 1.5; b.x = 4.5; b.y = 3.5; b.vx = 6; b.vy = 0;
    for (let i = 0; i < 40; i++) step(s, {}, B);
    if (n < 2) assert.ok(c.alive && c.hp === 2 - n, `after ball hit ${n + 1}: hp ${c.hp}`);
    assert.ok(s.player.ball.x < c.x, 'the ball bounced back');
  }
  assert.equal(c.alive, false);
});

test('walking into a cocoon does not break it; it is solid', () => {
  const s = createState(yard('#.P.O......#'));
  s.cocoons[0].reload = 99;
  run(s, toward(1, 0), 1.5);
  assert.equal(s.cocoons[0].alive, true);
  assert.ok(s.player.x < 4.5 - P.radius - P.cocoonRadius + 1e-6, `x=${s.player.x.toFixed(2)}`);
});

test('a cocoon spider hunts alone: it closes in and lunges without a partner', () => {
  const s = createState(yard('#.P........#'));
  makeSpider(s, 8.5, 3.5, { type: 'spider', mode: 'stalk' });
  const d0 = Math.hypot(s.critters[0].x - s.player.x, s.critters[0].y - s.player.y);
  run(s, {}, 1);
  assert.ok(Math.hypot(s.critters[0].x - s.player.x, s.critters[0].y - s.player.y) < d0 - 1.5, 'closed in');
  run(s, {}, 2);
  assert.ok(s.hits >= 1, 'hit the player');
});

test('cotton stainers still need a partner; spiders do not pair with them', () => {
  const s = createState(yard('#.P........#'));
  makeSpider(s, 4, 3.3);
  makeSpider(s, 4, 3.8, { type: 'spider', mode: 'stalk', cooldown: 99 });
  run(s, {}, 0.3);
  assert.notEqual(s.critters[0].mode, 'windup');
  assert.equal(s.critters[0].type, 'stainer');
});

test('vents only count cotton stainers toward their limit', () => {
  const s = createState({ name: 'v', map: ['##########', '#........#', '#.P....V.#', '#........#', '##########'] });
  for (let i = 0; i < P.maxSpiders; i++) makeSpider(s, 1.5 + (i % 3), 1.5, { type: 'spider', mode: 'stalk', cooldown: 99 });
  s.player.x = 5; s.player.y = 3.5;
  let spawned = false;
  for (let i = 0; i < 60 * 5 && !spawned; i++) { step(s, {}, P); spawned = s.events.some((e) => e.type === 'spawn'); }
  assert.ok(spawned);
});
