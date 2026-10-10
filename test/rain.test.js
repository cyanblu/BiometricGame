// Rain cycle, shelters, food, gnats, hearing, going home, lineage, threat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, step, DEFAULT_PARAMS, STEP, worldToScreen, makeSpider, rainLevel, threatLevel,
} from '../src/sim.js';
import { LEVELS } from '../src/levels.js';

const P = { ...DEFAULT_PARAMS, cycleLength: 4, rainWarn: 2 };
function toward(wx, wy) { const v = worldToScreen(wx, wy), l = Math.hypot(v.x, v.y); return { x: v.x / l, y: v.y / l }; }
function run(s, input, seconds, params = P) { for (let i = 0; i < Math.round(seconds / STEP); i++) step(s, input, params); return s; }
const events = (s, type) => s.events.filter((e) => e.type === type);

const room = (rows) => ({ name: 'r', map: rows });
// Player at (2,3), shelter at (9,3).
const sheltered = room(['############', '#..........#', '#..........#', '#.P......H.#', '#..........#', '#..........#', '############']);
const noShelter = room(['############', '#..........#', '#..........#', '#.P........#', '#..........#', '#..........#', '############']);

test('without shelters there is no rain cycle', () => {
  const s = createState(noShelter, 1, P);
  run(s, {}, 10);
  assert.equal(s.cycle.on, false);
  assert.equal(rainLevel(s), 0);
  assert.equal(s.player.health, P.maxHealth);
});

test('the cycle goes clear, warning, rain; the downpour hurts outside a shelter and can kill', () => {
  const s = createState(sheltered, 1, P);
  assert.equal(s.cycle.phase, 'clear');
  run(s, {}, 2.1);
  assert.equal(s.cycle.phase, 'warning');
  assert.ok(rainLevel(s) > 0 && rainLevel(s) <= 0.4);
  run(s, {}, 2);
  assert.equal(s.cycle.phase, 'rain');
  assert.equal(rainLevel(s), 1);
  assert.equal(s.player.health, P.maxHealth);
  run(s, {}, P.rainTick + 0.05);
  assert.equal(s.player.health, P.maxHealth - P.rainDamage);
  run(s, {}, P.rainTick * P.maxHealth);
  assert.ok(s.dead);
  assert.ok(events(s, 'death').some((e) => e.cause === 'rain'));
});

test('the downpour slows the bug', () => {
  const s = createState(noShelter, 1, P);
  s.cycle.on = true; s.cycle.t = 10; // in the downpour, but test the speed only
  s.player.health = 99;
  run(s, toward(0, 1), 0.5);
  assert.ok(Math.abs(Math.hypot(s.player.vx, s.player.vy) - P.maxSpeed * P.rainSlow) < 1e-6);
});

test('a shelter: no sleep while clear and hungry; sleeps with enough food', () => {
  const s = createState(sheltered, 1, { ...P, cycleLength: 100 });
  Object.assign(s.player, { x: 9.5, y: 3.5 });
  run(s, {}, 2, { ...P, cycleLength: 100 });
  assert.equal(s.cycle.n, 1, 'no food, no rain: stays awake');
  s.player.food = 5; s.player.health = 5;
  run(s, {}, P.sleepTime + 0.1, { ...P, cycleLength: 100 });
  assert.equal(s.cycle.n, 2);
  assert.equal(s.player.food, 1);
  assert.equal(s.player.health, 5 + P.sleepHeal);
  assert.ok(events(s, 'sleep').some((e) => e.fed));
});

test('once the warning starts any shelter will do, but a hungry sleep costs health', () => {
  const s = createState(sheltered, 1, P);
  run(s, {}, 2.1);
  Object.assign(s.player, { x: 9.5, y: 3.5 });
  run(s, {}, P.sleepTime + 0.1);
  assert.equal(s.cycle.n, 2);
  assert.equal(s.cycle.phase, 'clear');
  assert.equal(s.player.health, P.maxHealth - P.hungerDamage);
  assert.ok(events(s, 'sleep').some((e) => !e.fed));
});

test('standing in a shelter keeps the downpour off', () => {
  const params = { ...P, sleepTime: 999 }; // don't fall asleep, just stand there
  const s = createState(sheltered, 1, params);
  Object.assign(s.player, { x: 9.5, y: 3.5 });
  run(s, {}, 4.1 + P.rainTick * 3, params);
  assert.equal(s.cycle.phase, 'rain');
  assert.equal(s.player.health, P.maxHealth);
});

// Gnats: nest at (6,3), player at (2,3).
const nestRoom = room(['############', '#..........#', '#..........#', '#.P...n...H#', '#..........#', '#..........#', '############']);

test('nests start full; gnats flee the player', () => {
  const s = createState(nestRoom, 3, { ...P, cycleLength: 1000 });
  assert.equal(s.gnats.length, P.gnatsPerNest);
  const g = s.gnats[0];
  Object.assign(g, { x: 3.7, y: 3.5, vx: 0, vy: 0 });
  const d0 = Math.hypot(g.x - s.player.x, g.y - s.player.y);
  run(s, {}, 0.4, { ...P, cycleLength: 1000 });
  assert.ok(Math.hypot(g.x - s.player.x, g.y - s.player.y) > d0 + 0.5, 'ran away');
});

test('the bug eats a gnat it touches: +1 food', () => {
  const s = createState(nestRoom, 3, { ...P, cycleLength: 1000 });
  const g = s.gnats[0];
  Object.assign(g, { x: s.player.x + 0.1, y: s.player.y });
  step(s, {}, { ...P, cycleLength: 1000 });
  assert.equal(s.player.food, 1);
  assert.ok(events(s, 'eat').some((e) => e.who === 'player'));
  assert.ok(!s.gnats.includes(g));
});

test('gnats fly home before the rain and come back after a sleep', () => {
  const s = createState(nestRoom, 3, P);
  run(s, {}, 2 + 3);
  assert.equal(s.gnats.length, 0, 'all hidden');
  Object.assign(s.player, { x: 10.5, y: 3.5, vx: 0, vy: 0 });
  run(s, {}, P.sleepTime + 0.1);
  assert.equal(s.gnats.length, P.gnatsPerNest);
});

// Creatures.
const P2 = { ...P, cycleLength: 1000, maxSpiders: 0 };
const field = room([
  '####################', '#..................#', '#..................#', '#.P................#',
  '#..................#', '#..................#', '#.................H#', '####################',
]);

test('an idle stainer investigates a noise; one hunting the player ignores it', () => {
  const params = { ...P2, noiseDash: 9 };
  const s = createState(field, 1, params);
  const far = makeSpider(s, 9.5, 3.5, { cooldown: 99 });
  const near = makeSpider(s, 5.5, 3.5, { cooldown: 99 });
  step(s, { dash: true }, params);
  assert.ok(events(s, 'noise').length > 0);
  assert.ok(far.listen, 'far one listens');
  assert.equal(near.listen, null, 'the one already in aggro range ignores it');
  const d0 = Math.hypot(far.x - far.listen.x, far.y - far.listen.y);
  run(s, {}, 1, params);
  assert.ok(Math.hypot(far.x - 2.5, far.y - 3.5) < d0 - 0.5, 'walked toward the sound');
});

test('before the rain, stainers walk home to a vent and burrow; vents stay shut', () => {
  const lvl = room([
    '####################', '#..................#', '#.V................#', '#..................#',
    '#..................#', '#..........b.......#', '#.P...............H#', '####################',
  ]);
  const params = { ...P, cycleLength: 30, rainWarn: 25 };
  const s = createState(lvl, 1, params);
  run(s, {}, 5.1, params);
  assert.equal(s.cycle.phase, 'warning');
  const mark = s.events.length;
  run(s, {}, 12, params);
  assert.equal(s.critters.filter((c) => c.alive).length, 0, 'everyone went home');
  assert.ok(s.events.slice(mark).some((e) => e.type === 'burrow'));
  assert.ok(!s.events.slice(mark).some((e) => e.type === 'spawn'), 'vents stay shut');
});

test('a hungry stainer hunts a gnat and eats it', () => {
  const lvl = room([
    '####################', '#..................#', '#..........n.......#', '#..................#',
    '#..................#', '#..................#', '#.P...............H#', '####################',
  ]);
  const s = createState(lvl, 2, P2);
  const c = makeSpider(s, 11.5, 4.5, { hunger: P2.hungerTime, cooldown: 99 });
  let ate = false;
  for (let i = 0; i < 600 && !ate; i++) { step(s, {}, P2); ate = s.events.some((e) => e.type === 'eat' && e.who === c.id); }
  assert.ok(ate);
  assert.ok(c.hunger < 1);
});

test('lineage: a vent that lost stainers sends elders, and an elder survives one dash', () => {
  const lvl = room(['############', '#..........#', '#..V.......#', '#..........#', '#..........#', '#........P.#', '############']);
  const params = { ...DEFAULT_PARAMS, ventMin: 0.1, ventMax: 0.1, maxSpiders: 30 };
  const s = createState(lvl, 5, params);
  s.vents[0].lineage = 3;
  run(s, {}, 4, params);
  const elders = s.critters.filter((c) => c.elder);
  assert.ok(elders.length > 0, 'elders appeared');
  assert.ok(elders.length < s.critters.length, 'not every one is an elder (75 %)');

  const t = createState(lvl, 5, params);
  t.vents.length = 0;
  const e = makeSpider(t, t.player.x, t.player.y - 0.9, { elder: true, hp: 2, cooldown: 99 });
  t.player.faceX = 0; t.player.faceY = -1;
  step(t, { dash: true }, params);
  run(t, {}, 0.2, params);
  assert.ok(e.alive, 'survived the first dash');
  assert.ok(t.events.some((v) => v.type === 'elderHit') || e.hp === 1);
  run(t, {}, 1, params);
  Object.assign(e, { x: t.player.x, y: t.player.y - 0.6, mode: 'wander', vx: 0, vy: 0 });
  t.player.dashCooldown = 0;
  step(t, { dash: true }, params);
  run(t, {}, 0.1, params);
  assert.ok(!e.alive, 'the second dash kills');
});

test('killing a stainer raises its vent lineage', () => {
  const lvl = room(['############', '#..........#', '#..V.......#', '#..........#', '#..........#', '#........P.#', '############']);
  const s = createState(lvl, 5, DEFAULT_PARAMS);
  const c = makeSpider(s, s.player.x, s.player.y - 0.6, { vent: 0, cooldown: 99 });
  s.player.faceX = 0; s.player.faceY = -1;
  step(s, { dash: true }, DEFAULT_PARAMS);
  run(s, {}, 0.1, DEFAULT_PARAMS);
  assert.ok(!c.alive);
  assert.equal(s.vents[0].lineage, 1);
});

test('threat rises with danger', () => {
  const s = createState(field, 1, P2);
  assert.equal(threatLevel(s, P2), 0);
  const a = makeSpider(s, 4.5, 3.5, { mode: 'windup', cooldown: 99 });
  assert.ok(threatLevel(s, P2) > 0.5);
  a.alive = false;
  s.player.webbed = 1;
  assert.ok(threatLevel(s, P2) > 0.2 && threatLevel(s, P2) < 0.3);
});

test('the arena has a shelter and gnat nests in every biome', () => {
  const lv = LEVELS[0], s = createState(lv, 1, DEFAULT_PARAMS);
  assert.equal(s.cycle.on, true);
  const biomesWith = (list) => new Set(list.map((o) => s.map.biome[Math.floor(o.y) * s.map.w + Math.floor(o.x)]));
  assert.equal(biomesWith(s.shelters).size, 5);
  assert.equal(biomesWith(s.nests).size, 5);
});
