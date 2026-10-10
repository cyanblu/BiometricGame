// Dung beetle: the ball has momentum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, step, DEFAULT_PARAMS, STEP, worldToScreen, wallClearance, makeSpider } from '../src/sim.js';

const BALL = { ...DEFAULT_PARAMS, mech: 'ball' };
const P = BALL;
const room = { name: 'r', map: ['################', '#..............#', '#..............#', '#.P............#', '#..............#', '#..............#', '################'] };

function toward(wx, wy) { const v = worldToScreen(wx, wy), l = Math.hypot(v.x, v.y); return { x: v.x / l, y: v.y / l }; }
function run(s, input, seconds, params = P) { for (let i = 0; i < Math.round(seconds / STEP); i++) step(s, typeof input === 'function' ? input(i) : input, params); return s; }
const ballSpeed = (s) => Math.hypot(s.player.ball.vx, s.player.ball.vy);
const gap = P.radius + P.ballRadius;

test('the ball starts next to the beetle, not inside it', () => {
  const s = createState(room, 1, P);
  assert.ok(s.player.ball);
  const d = Math.hypot(s.player.ball.x - s.player.x, s.player.ball.y - s.player.y);
  assert.ok(d >= gap - 1e-9 && d < gap + 0.2, `gap ${d}`);
  assert.equal(createState(room, 1, DEFAULT_PARAMS).player.ball, undefined);
});

test('pushing builds speed slowly (unlike walking)', () => {
  const s = createState(room, 1, P);
  run(s, toward(1, 0), 0.3);
  const early = ballSpeed(s);
  run(s, toward(1, 0), 0.5);
  const later = ballSpeed(s);
  assert.ok(early < P.ballMax * 0.5, `0.3 s: ${early.toFixed(2)}`);
  assert.ok(later > early + 1, `0.8 s: ${later.toFixed(2)}`);
});

test('momentum: let go and the ball keeps rolling, then stops by friction', () => {
  const s = createState(room, 1, P);
  run(s, toward(1, 0), 0.8);
  const v0 = ballSpeed(s), x0 = s.player.ball.x;
  run(s, {}, 0.5);
  assert.ok(s.player.ball.x - x0 > 0.8, `coasted ${(s.player.ball.x - x0).toFixed(2)} tiles`);
  run(s, {}, v0 / P.ballDecel + 0.5);
  assert.ok(ballSpeed(s) < 1e-9, 'stopped eventually');
});

test('the beetle follows its ball and never overlaps it; nothing enters walls', () => {
  const s = createState(room, 1, P);
  const script = (i) => (i % 120 < 60 ? toward(1, Math.sin(i / 20)) : toward(-1, 0.3));
  for (let i = 0; i < 600; i++) {
    step(s, script(i), P);
    const d = Math.hypot(s.player.ball.x - s.player.x, s.player.ball.y - s.player.y);
    assert.ok(d >= gap - 1e-6, `overlap at ${i}: ${d}`);
    assert.ok(wallClearance(s, P.radius) > -1e-6);
    assert.ok(wallClearance(s, P.ballRadius, s.player.ball) > -1e-6, `ball in wall at ${i}`);
  }
});

test('the ball bounces off a wall, losing speed', () => {
  const s = createState(room, 1, P);
  const b = s.player.ball;
  b.x = 13; b.y = 3.5; b.vx = 5; b.vy = 0;
  s.player.x = 11; s.player.y = 3.5;
  let bounced = false;
  for (let i = 0; i < 60 && !bounced; i++) { step(s, {}, P); bounced = b.vx < 0; }
  assert.ok(bounced, 'came back');
  assert.ok(-b.vx <= 5 * P.ballBounce + 1e-6, `rebound ${b.vx}`);
});

test('a dash next to the ball kicks it (one charge), away from the beetle', () => {
  const s = createState(room, 1, P);
  const charges = s.player.charges;
  const b = s.player.ball;
  const dir = [b.x - s.player.x, b.y - s.player.y];
  step(s, { dash: true }, P);
  assert.equal(s.player.charges, charges - 1);
  assert.equal(s.player.dashTime, 0, 'the beetle itself does not dash');
  assert.ok(ballSpeed(s) > P.ballKick * 0.9);
  assert.ok(b.vx * dir[0] + b.vy * dir[1] > 0, 'away from the beetle');
  assert.ok(s.events.some((e) => e.type === 'kick'));
});

test('away from the ball, a dash is a normal beetle dash', () => {
  const s = createState(room, 1, P);
  s.player.ball.x = 12; s.player.ball.y = 5;
  s.player.faceX = 1; s.player.faceY = 0;
  step(s, { dash: true }, P);
  assert.ok(s.player.dashTime > 0);
});

test('a fast ball squashes spiders, a slow one does not', () => {
  for (const [speed, kills] of [[P.ballKillSpeed + 2, 1], [P.ballKillSpeed - 1.5, 0]]) {
    const s = createState(room, 1, P);
    const b = s.player.ball;
    s.player.x = 3; s.player.y = 1.5; b.x = 5; b.y = 3.5; b.vx = speed; b.vy = 0;
    makeSpider(s, 6.2, 3.5, { mode: 'thrown', stateTime: 99, cooldown: 99 });
    run(s, {}, 0.6);
    assert.equal(s.kills, kills, `ball at ${speed} tiles/s`);
  }
});

test('the ball picks up batteries it rolls over', () => {
  const lvl = { ...room, map: room.map.map((r, y) => (y === 3 ? '#.P.....*......#' : r)) };
  const s = createState(lvl, 1, P);
  const b = s.player.ball;
  s.player.x = 3; s.player.y = 1.5; b.x = 5; b.y = 3.5; b.vx = 4; b.vy = 0;
  run(s, {}, 1);
  assert.equal(s.collected, 1);
});

test('deterministic', () => {
  const script = (i) => ({ ...toward(Math.cos(i / 40), Math.sin(i / 30)), dash: i % 70 === 0 });
  const a = run(createState(room, 3, P), script, 8), b = run(createState(room, 3, P), script, 8);
  assert.deepEqual([a.player.ball.x, a.player.ball.y, a.player.x], [b.player.ball.x, b.player.ball.y, b.player.x]);
});
