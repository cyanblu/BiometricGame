// Pure game simulation. No DOM, no canvas, no randomness: the same inputs
// always produce the same state, so it can be tested headless in Node.
// Behaviour and numbers are specified in docs/SPEC.md.

export const STEP = 1 / 60;
export const TILE_W = 64;
export const TILE_H = 32;

export const DEFAULT_PARAMS = {
  radius: 0.3,
  maxSpeed: 4.5,
  accel: 30,
  decel: 35,
  dashSpeed: 13,
  dashDuration: 0.14,
  dashCooldown: 0.55,
  dashBuffer: 0.1,
  pickupRange: 0.35,
  diagonalMode: 'screen', // 'screen' | 'grid'
  dashHeat: 0.34,
  heatCool: 0.3,
  overheatRecover: 0.35, // overheated until heat cools to this
  overheatSpeed: 0.65, // top speed multiplier while overheated
  startCharges: 10, // dash charges at the start
  maxCharges: 30,
  smallCharge: 3, // charges in a small battery cell
  bigCharge: 9, // charges in a big red battery
  maxHealth: 10,
  hitDamage: 1,
  ventFirstMin: 1.5, ventFirstMax: 3.5, // first spawn per vent, s
  ventMin: 4, ventMax: 8, // spawn interval per vent, s
  maxSpiders: 8, // alive at once
  ventSafe: 1.5, // no spawn while the player is this close to the vent
  emergeTime: 0.6,
  spawnCooldown: 1.5, // attack cooldown of a freshly spawned spider
  corpseTime: 12,
  // Falling: entities can step off ledges (never climb them).
  gravity: 30, // levels/s²
  airControl: 0.35, // share of acceleration available in the air
  fallStunHeight: 1.5, // landing from this many levels or more stuns
  fallStun: 0.25, // s
  // Cocoons with web turrets, and the spiders inside them.
  cocoonRadius: 0.32,
  cocoonHits: 3, // dash hits (or fast-ball hits) to break one open
  cocoonRecoil: 4, // tiles/s the player bounces off a cocoon it dashed into
  turretRange: 7, // tiles
  turretTurn: 3, // rad/s
  turretCharge: 0.45, // s of visible wind-up before a shot
  turretReload: 2.6, // s between shots (x 0.8..1.2)
  webSpeed: 6.5, // tiles/s
  webRadius: 0.18,
  webRange: 9, // tiles before a web drops
  webDuration: 2.5, // s of slowdown
  webSlow: 0.45, // speed and acceleration multiplier while webbed
  spiderDrop: 1.4, // levels above the cocoon a spider falls from
  spiderSpeed: 2.6,
  spiderAggro: 8,
  spiderLungeRange: 1.6,
  spiderWindup: 0.3,
  spiderLungeSpeed: 7.5,
  spiderLungeTime: 0.28,
  spiderCooldown: 1.6,
  // Movement mechanics: 'normal', or 'ball' (dung beetle pushing a ball).
  mech: 'normal',
  ballRadius: 0.32,
  ballPush: 7, // ball acceleration while the beetle pushes it, tiles/s²
  ballMax: 6.5, // fastest the beetle can push it
  ballDecel: 1.6, // rolling friction, tiles/s²
  ballBounce: 0.45, // share of speed kept when it bounces off a wall
  ballKick: 9, // ball speed after a dash kick
  ballKillSpeed: 3, // a ball at least this fast squashes spiders
  beetleSpeed: 6, // how fast the beetle runs to get behind its ball
  ballEngage: 0.6, // beyond touching distance + this (or on another floor) the beetle walks freely
  critterRadius: 0.18,
  critterSpeed: 1.1,
  critterFleeSpeed: 3.2,
  critterAccel: 12,
  critterFear: 2.2,
  // Spider pack hunting: they only attack as a pair standing next to each other.
  aggroRange: 4.5, // player this close: spiders want to attack
  pairRange: 1.3, // two spiders this close form a pair
  regroupRange: 6, // a lone spider walks to a partner this close
  regroupSpeed: 1.8,
  windup: 0.45, // pair charges an arc, standing still
  lungeSpeed: 6.5,
  lungeTime: 0.35,
  thrownSpeed: 5,
  thrownTime: 0.5,
  attackCooldown: 3, // after being thrown, before a spider can pair up again
  killMargin: 0.12, // extra reach of a dash against spiders
  hitHeat: 0.45,
  knockback: 7,
  stunTime: 0.35,
  invulnTime: 0.8,
};

// Seeded PRNG (mulberry32) kept in the state, so runs stay reproducible.
export function rand(state) {
  state.seed = (state.seed + 0x6d2b79f5) >>> 0;
  let t = state.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function parseLevel(def) {
  const rows = def.map;
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const solid = new Uint8Array(w * h);
  // Terrain: base level per tile, plus slopes. kind 0 flat, 1 ramp, 2 stairs;
  // (dx, dy) is the direction the slope rises in.
  const level = new Float32Array(w * h);
  const kind = new Uint8Array(w * h);
  const sdx = new Int8Array(w * h), sdy = new Int8Array(w * h);
  const hrows = def.heights || [];
  const SLOPES = {
    '>': [1, 1, 0], '<': [1, -1, 0], v: [1, 0, 1], '^': [1, 0, -1],
    E: [2, 1, 0], W: [2, -1, 0], S: [2, 0, 1], N: [2, 0, -1],
  };
  const shards = [];
  const critters = [];
  const vents = [];
  const cocoons = [];
  let spawn = { x: w / 2, y: h / 2 };
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const c = rows[ty][tx] ?? '#';
      if (c === '#') solid[ty * w + tx] = 1;
      else if (c === 'P') spawn = { x: tx + 0.5, y: ty + 0.5 };
      else if (c === '*') shards.push({ x: tx + 0.5, y: ty + 0.5, big: false });
      else if (c === 'B') shards.push({ x: tx + 0.5, y: ty + 0.5, big: true });
      else if (c === 'V') vents.push({ x: tx + 0.5, y: ty + 0.5 });
      else if (c === 'O') cocoons.push({ x: tx + 0.5, y: ty + 0.5 });
      else if (c === 'b' || c === 's') critters.push({ x: tx + 0.5, y: ty + 0.5 });
      const hc = (hrows[ty] ?? '')[tx] ?? '0';
      const i = ty * w + tx;
      if (SLOPES[hc]) [kind[i], sdx[i], sdy[i]] = SLOPES[hc];
      else level[i] = Number(hc) || 0;
    }
  }
  // A slope starts at the level of the flat tile on its low side.
  for (let i = 0; i < w * h; i++) {
    if (!kind[i]) continue;
    const tx = i % w, ty = Math.floor(i / w);
    const lx = tx - sdx[i], ly = ty - sdy[i];
    level[i] = lx >= 0 && ly >= 0 && lx < w && ly < h ? level[ly * w + lx] : 0;
  }
  return { name: def.name, w, h, solid, level, kind, sdx, sdy, shards, critters, vents, cocoons, spawn };
}

export function isSolid(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
  return map.solid[ty * map.w + tx] === 1;
}

// Two surfaces meet if their heights differ by less than this (in levels).
export const LEVEL_TOL = 0.12;

// Height (in levels) of tile (tx, ty)'s surface at world point (x, y),
// clamped into the tile. Ramps and stairs rise by one level across the tile.
export function tileLevelAt(map, tx, ty, x, y) {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return 0;
  const i = ty * map.w + tx;
  const base = map.level[i];
  if (!map.kind[i]) return base;
  const fx = Math.min(1, Math.max(0, x - tx)), fy = Math.min(1, Math.max(0, y - ty));
  const dx = map.sdx[i], dy = map.sdy[i];
  const f = dx > 0 ? fx : dx < 0 ? 1 - fx : dy > 0 ? fy : 1 - fy;
  return base + f;
}

export function groundLevel(map, x, y) {
  return tileLevelAt(map, Math.floor(x), Math.floor(y), x, y);
}

// Largest drop (levels) that still counts as walking, e.g. down a ramp.
export const STEP_DOWN = 0.15;

// Does tile (tx, ty) block entity e (with x, y, z, air) at contact point
// (cx, cy)? Walls always do. Other tiles only when their surface there is
// higher than the entity: you can step off a ledge, never walk up a cliff.
// On the ground the comparison uses the entity's own tile at the contact
// point, which is what lets a body leave the top of a ramp; in the air (or
// already past the edge) it uses the entity's height.
export function blocks(map, e, tx, ty, cx, cy) {
  if (isSolid(map, tx, ty)) return true;
  const ox = Math.floor(e.x), oy = Math.floor(e.y);
  if (tx === ox && ty === oy) return false;
  const airborne = e.air || tileLevelAt(map, ox, oy, e.x, e.y) < e.z - STEP_DOWN;
  const here = airborne ? e.z : tileLevelAt(map, ox, oy, cx, cy);
  return tileLevelAt(map, tx, ty, cx, cy) > here + LEVEL_TOL;
}

// Can you get from tile a to its 4-neighbour b (on foot or by dropping)?
export function canPass(map, ax, ay, bx, by) {
  if (isSolid(map, ax, ay) || isSolid(map, bx, by)) return false;
  const ex = bx > ax ? bx : bx < ax ? ax : null, ey = by > ay ? by : by < ay ? ay : null;
  for (const t of [0.05, 0.5, 0.95]) {
    const x = ex ?? ax + t, y = ey ?? ay + t;
    if (tileLevelAt(map, bx, by, x, y) > tileLevelAt(map, ax, ay, x, y) + LEVEL_TOL) return false;
  }
  return true;
}

// Vertical motion after a horizontal move: follow the ground on slopes and
// small steps, otherwise fall. Returns the height fallen when it lands.
function settle(map, e, dt, params, r) {
  const ground = groundLevel(map, e.x, e.y);
  e.pz ??= e.z;
  if (!e.air) {
    if (ground >= e.z - STEP_DOWN) { e.z = ground; return 0; }
    e.air = true; e.vz = 0; e.fallFrom = e.z;
  }
  e.vz -= params.gravity * dt;
  e.z += e.vz * dt;
  let fell = 0;
  if (e.z <= ground) {
    fell = Math.max(e.fallFrom - ground, 1e-6);
    e.z = ground; e.vz = 0; e.air = false;
  }
  // Having dropped, a cliff face it was beside may now be above it: slide off it.
  resolveWalls(map, e, r, [e]);
  return fell;
}

// Open edge between 4-neighbours a and b (used for reachability checks).
export function edgeOpen(map, ax, ay, bx, by) {
  if (isSolid(map, ax, ay) || isSolid(map, bx, by)) return false;
  // Sample the shared edge at both ends and the middle.
  const ex = bx > ax ? bx : bx < ax ? ax : null, ey = by > ay ? by : by < ay ? ay : null;
  for (const t of [0.05, 0.5, 0.95]) {
    const x = ex ?? ax + t, y = ey ?? ay + t;
    if (Math.abs(tileLevelAt(map, ax, ay, x, y) - tileLevelAt(map, bx, by, x, y)) > LEVEL_TOL) return false;
  }
  return true;
}

// A new spider. Spiders have ids because they come and go (vents, corpses).
export function makeSpider(state, x, y, extra = {}) {
  const c = {
    id: state.nextId++,
    x, y, z: groundLevel(state.map, x, y), pz: 0, vz: 0, air: false, px: x, py: y, vx: 0, vy: 0,
    dirX: 0, dirY: 0, timer: 0, fleeing: false,
    type: 'stainer', // 'stainer' (cotton stainer, hunts in pairs) or 'spider' (from cocoons, hunts alone)
    alive: true, mode: 'wander', cooldown: 0, partner: -1, role: 0, hitDone: false,
    lungeX: 0, lungeY: 0, stateTime: 0, stateTotal: 0, deadTime: 0,
    ...extra,
  };
  state.critters.push(c);
  return c;
}

export function createState(level, seed = 1, params = DEFAULT_PARAMS) {
  const map = parseLevel(level);
  const state = {
    seed: seed >>> 0,
    nextId: 1,
    critters: [],
    vents: [],
    events: [], // drained by the browser; never read by the simulation
    kills: 0,
    hits: 0,
    map,
    player: {
      x: map.spawn.x, y: map.spawn.y, z: groundLevel(map, map.spawn.x, map.spawn.y), vz: 0, air: false,
      px: map.spawn.x, py: map.spawn.y, // position before the last step, for render interpolation
      vx: 0, vy: 0,
      faceX: Math.SQRT1_2, faceY: Math.SQRT1_2,
      dashTime: 0, dashCooldown: 0, dashBuffer: 0,
      dashX: 0, dashY: 0,
      heat: 0, // 0..1, rises with each dash, cools over time
      overheated: false, // set when heat hits 1: no dash, slower
      charges: params.startCharges, // each dash spends one
      health: params.maxHealth,
      stun: 0, invuln: 0,
      webbed: 0, // s of web slowdown left
      dashId: 0, // counts dashes, so one dash hits a cocoon only once
    },
    shards: map.shards.map((s) => ({ x: s.x, y: s.y, big: s.big, taken: false })),
    collected: 0,
    time: 0,
    won: false,
    dead: false,
    tick: 0,
  };
  map.critters.forEach((c, i) => makeSpider(state, c.x, c.y, { timer: 0.3 * i }));
  if (params.mech === 'ball') {
    const p = state.player, gap = params.radius + params.ballRadius;
    p.ball = { x: p.x + p.faceX * gap, y: p.y + p.faceY * gap, vx: 0, vy: 0, z: p.z, vz: 0, air: false };
    move(map, p.ball, { vx: 0, vy: 0 }, 0, params.ballRadius);
    separate(map, p, p.ball, gap, params);
  }
  state.cocoons = map.cocoons.map((c) => ({
    id: state.nextId++, x: c.x, y: c.y, z: groundLevel(map, c.x, c.y), alive: true,
    aim: rand(state) * Math.PI * 2, reload: 1 + rand(state) * 2, charge: 0, sees: false,
    hp: params.cocoonHits, lastDash: -1, ballCool: 0,
  }));
  state.webs = [];
  state.vents = map.vents.map((v) => ({
    x: v.x, y: v.y,
    timer: params.ventFirstMin + rand(state) * (params.ventFirstMax - params.ventFirstMin),
  }));
  return state;
}

export function worldToScreen(x, y) {
  return { x: (x - y) * (TILE_W / 2), y: (x + y) * (TILE_H / 2) };
}

// Screen-space stick (y down) to a world-space direction with length <= 1.
export function inputToWorld(ix, iy, mode) {
  const mag = Math.min(1, Math.hypot(ix, iy));
  if (mag < 1e-6) return { x: 0, y: 0, mag: 0 };
  let wx, wy;
  if (mode === 'grid') {
    wx = ix + iy;
    wy = iy - ix;
  } else {
    // Inverse of worldToScreen, so the projected direction matches the input.
    wx = ix / TILE_W + iy / TILE_H;
    wy = iy / TILE_H - ix / TILE_W;
  }
  const len = Math.hypot(wx, wy);
  return { x: (wx / len) * mag, y: (wy / len) * mag, mag };
}

function approach(vx, vy, tx, ty, maxDelta) {
  const dx = tx - vx;
  const dy = ty - vy;
  const d = Math.hypot(dx, dy);
  if (d <= maxDelta || d === 0) return [tx, ty];
  return [vx + (dx / d) * maxDelta, vy + (dy / d) * maxDelta];
}

// Push the circle out of every wall it overlaps and drop the velocity
// component pointing into the wall.
function resolveWalls(map, p, r, vels) {
  for (let pass = 0; pass < 4; pass++) {
    let hit = false;
    const x0 = Math.floor(p.x - r), x1 = Math.floor(p.x + r);
    const y0 = Math.floor(p.y - r), y1 = Math.floor(p.y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const cx = Math.min(Math.max(p.x, tx), tx + 1);
        const cy = Math.min(Math.max(p.y, ty), ty + 1);
        if (!blocks(map, p, tx, ty, cx, cy)) continue;
        let nx = p.x - cx;
        let ny = p.y - cy;
        const d2 = nx * nx + ny * ny;
        if (d2 >= r * r) continue;
        let push;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          nx /= d; ny /= d;
          push = r - d;
        } else {
          // Centre is inside the tile: leave through the nearest face.
          const faces = [
            [p.x - tx, -1, 0], [tx + 1 - p.x, 1, 0],
            [p.y - ty, 0, -1], [ty + 1 - p.y, 0, 1],
          ].sort((a, b) => a[0] - b[0]);
          [push, nx, ny] = faces[0];
          push += r;
        }
        p.x += nx * push;
        p.y += ny * push;
        for (const v of vels) {
          const vn = v.vx * nx + v.vy * ny;
          if (vn < 0) { v.vx -= vn * nx; v.vy -= vn * ny; }
        }
        hit = true;
      }
    }
    if (!hit) break;
  }
}

// Move by (mv * dt) in sub-steps no longer than half the radius. Wall
// contacts clip both the move velocity and the player's stored velocity.
function move(map, p, mv, dt, r) {
  const dist = Math.hypot(mv.vx, mv.vy) * dt;
  const n = Math.max(1, Math.ceil(dist / (r * 0.5)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    p.x += mv.vx * h;
    p.y += mv.vy * h;
    resolveWalls(map, p, r, [mv, p]);
  }
}

const SAME_FLOOR = 0.5; // vertical reach for pickups, hits and kills (levels)

// input: { x, y } screen-space stick in [-1, 1], dash: true on the step the
// button went down.
export function step(state, input, params = DEFAULT_PARAMS, dt = STEP) {
  const p = state.player;
  if (state.dead) {
    // Frozen: keep interpolation still, change nothing else.
    p.px = p.x; p.py = p.y;
    p.pz = p.z;
    for (const c of state.critters) { c.px = c.x; c.py = c.y; c.pz = c.z; }
    return state;
  }
  const r = params.radius;
  p.px = p.x; p.py = p.y; p.pz = p.z;

  p.stun = Math.max(0, p.stun - dt);
  p.invuln = Math.max(0, p.invuln - dt);
  if (p.webbed > 0) {
    p.webbed = Math.max(0, p.webbed - dt);
    if (p.webbed === 0) state.events.push({ type: 'webFree' });
  }
  const stunned = p.stun > 0;
  const dir = stunned ? { x: 0, y: 0, mag: 0 } : inputToWorld(input.x || 0, input.y || 0, params.diagonalMode);
  if (dir.mag > 0) {
    p.faceX = dir.x / dir.mag;
    p.faceY = dir.y / dir.mag;
  }

  p.dashCooldown = Math.max(0, p.dashCooldown - dt);
  p.dashBuffer = Math.max(0, p.dashBuffer - dt);
  if (input.dash) p.dashBuffer = params.dashBuffer;

  if (p.dashBuffer > 0 && p.dashCooldown <= 0 && p.dashTime <= 0 && !p.overheated && !stunned && p.charges > 0) {
    p.charges--;
    p.dashX = p.faceX; p.dashY = p.faceY;
    p.dashId++;
    // Dung beetle next to its ball: the dash kicks the ball instead.
    p.dashTime = params.mech === 'ball' && kickBall(state, params) ? 0 : params.dashDuration;
    p.dashCooldown = params.dashCooldown;
    p.dashBuffer = 0;
    if (p.webbed > 0) { p.webbed = 0; state.events.push({ type: 'webTorn' }); } // a dash tears the web
    p.heat = Math.min(1, p.heat + params.dashHeat);
    if (p.heat >= 1) p.overheated = true;
  } else {
    p.heat = Math.max(0, p.heat - params.heatCool * dt);
    if (p.overheated && p.heat <= params.overheatRecover) p.overheated = false;
  }
  const slow = p.webbed > 0 ? params.webSlow : 1;
  const topSpeed = params.maxSpeed * (p.overheated ? params.overheatSpeed : 1) * slow;

  let mvx, mvy;
  const dashing = p.dashTime > 0;
  if (params.mech === 'ball' && !dashing) {
    stepBall(state, dir, params, dt, topSpeed);
    mvx = p.vx; mvy = p.vy;
  } else if (dashing) {
    // Blend the step in which the dash ends, so dash distance does not
    // depend on how the duration lines up with the step size.
    const inDash = Math.min(dt, p.dashTime);
    const speed = (params.dashSpeed * inDash + params.maxSpeed * (dt - inDash)) / dt;
    mvx = p.dashX * speed;
    mvy = p.dashY * speed;
    p.dashTime -= dt;
    if (p.dashTime <= 0) {
      p.dashTime = 0;
      p.vx = p.dashX * params.maxSpeed;
      p.vy = p.dashY * params.maxSpeed;
    } else {
      p.vx = mvx; p.vy = mvy;
    }
  } else {
    const has = dir.mag > 0;
    const grip = p.air ? params.airControl : 1; // little steering in the air
    [p.vx, p.vy] = approach(
      p.vx, p.vy,
      dir.x * topSpeed, dir.y * topSpeed,
      (has ? params.accel * slow : params.decel) * grip * dt,
    );
    mvx = p.vx; mvy = p.vy;
  }

  move(state.map, p, { vx: mvx, vy: mvy }, dt, r);
  if (p.ball) separate(state.map, p, p.ball, r + params.ballRadius, params);
  if (!dashing) {
    for (const c of state.cocoons) {
      if (!c.alive || Math.abs(c.z - p.z) >= SAME_FLOOR) continue;
      const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy), min = r + params.cocoonRadius;
      if (d < min && d > 1e-9) {
        p.x += (dx / d) * (min - d); p.y += (dy / d) * (min - d);
        const vn = (p.vx * dx + p.vy * dy) / d;
        if (vn < 0) { p.vx -= (vn * dx) / d; p.vy -= (vn * dy) / d; }
        move(state.map, p, { vx: 0, vy: 0 }, 0, r);
      }
    }
  }
  const fell = settle(state.map, p, dt, params, r);
  if (fell >= 0.5) {
    state.events.push({ type: 'land', who: 'player', x: p.x, y: p.y, height: fell });
    if (fell >= params.fallStunHeight) p.stun = Math.max(p.stun, params.fallStun);
  }

  const reach = r + params.pickupRange;
  for (const s of state.shards) {
    if (s.taken) continue;
    const near = (e, rr) => Math.hypot(s.x - e.x, s.y - e.y) <= rr && Math.abs(groundLevel(state.map, s.x, s.y) - e.z) < SAME_FLOOR;
    if (near(p, reach) || (p.ball && near(p.ball, params.ballRadius + params.pickupRange * 0.5))) {
      s.taken = true;
      state.collected++;
      const gain = s.big ? params.bigCharge : params.smallCharge;
      p.charges = Math.min(params.maxCharges, p.charges + gain);
      state.events.push({ type: 'pickup', x: s.x, y: s.y, big: s.big });
    }
  }

  stepVents(state, params, dt);
  stepCocoons(state, params, dt, dashing);
  stepWebs(state, params, dt, dashing);
  stepSpiders(state, params, dt, dashing);

  if (!state.won && !state.dead) {
    state.time += dt;
    // A level without cells has no win condition (test rooms).
    if (state.shards.length > 0 && state.collected === state.shards.length) {
      state.won = true;
      state.events.push({ type: 'win' });
    }
  }
  state.tick++;
  return state;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// A spider that is free to pair up for an attack.
const canPair = (c) => c.alive && c.type === 'stainer' && c.mode === 'wander' && c.cooldown <= 0;

function nearestPartner(state, c, range) {
  let best = null, bestD = range;
  for (const o of state.critters) {
    if (o === c || !canPair(o)) continue;
    const d = dist(c, o);
    if (d <= bestD) { best = o; bestD = d; }
  }
  return best;
}

function hitPlayer(state, c, params) {
  const p = state.player;
  if (p.invuln > 0) return;
  const dx = p.x - c.x, dy = p.y - c.y, l = Math.hypot(dx, dy) || 1;
  p.vx = (dx / l) * params.knockback; p.vy = (dy / l) * params.knockback;
  p.stun = params.stunTime;
  p.invuln = params.invulnTime;
  p.dashBuffer = 0;
  p.heat = Math.min(1, p.heat + params.hitHeat);
  if (p.heat >= 1) p.overheated = true;
  p.health = Math.max(0, p.health - params.hitDamage);
  state.hits++;
  state.events.push({ type: 'hit', x: p.x, y: p.y, health: p.health });
  if (p.health <= 0 && !state.won) {
    state.dead = true;
    state.events.push({ type: 'death' });
  }
}

function killSpider(state, c, dirX = state.player.dashX, dirY = state.player.dashY) {
  c.alive = false; c.mode = 'dead'; c.vx = 0; c.vy = 0; c.deadTime = 0;
  state.kills++;
  state.events.push({ type: 'kill', id: c.id, x: c.x, y: c.y, dirX, dirY });
}

// ---- cocoons, web turrets, webs -------------------------------------------------

// Clear line between two points at height z: no wall, no ground higher than
// z + half a level in between (sampled every quarter tile).
export function lineOfSight(map, ax, ay, bx, by, z) {
  const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / 0.25));
  for (let i = 1; i < n; i++) {
    const x = ax + ((bx - ax) * i) / n, y = ay + ((by - ay) * i) / n;
    if (isSolid(map, Math.floor(x), Math.floor(y)) || groundLevel(map, x, y) > z + 0.5) return false;
  }
  return true;
}

// Each cocoon carries a turret: it turns toward the player while it can see
// them, charges for a moment once lined up, and fires a web.
function stepCocoons(state, params, dt, dashing) {
  const p = state.player;
  for (const c of state.cocoons) {
    if (!c.alive) continue;
    // Takes cocoonHits hits: each dash counts once (the dash stops and the
    // player bounces off), and a fast ball counts once per bounce.
    c.ballCool = Math.max(0, c.ballCool - dt);
    const ball = p.ball;
    let hit = false;
    if (dashing && c.lastDash !== p.dashId && Math.abs(c.z - p.z) < SAME_FLOOR
      && dist(c, p) < params.radius + params.cocoonRadius + params.killMargin) {
      c.lastDash = p.dashId;
      hit = true;
      const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy) || 1;
      p.dashTime = 0;
      p.vx = (dx / d) * params.cocoonRecoil; p.vy = (dy / d) * params.cocoonRecoil;
    }
    if (ball && Math.abs(c.z - ball.z) < SAME_FLOOR) {
      // The ball is stopped by a cocoon and bounces off it.
      const dx = ball.x - c.x, dy = ball.y - c.y, d = Math.hypot(dx, dy), min = params.ballRadius + params.cocoonRadius;
      if (d < min && d > 1e-9) {
        const nx = dx / d, ny = dy / d, bs = Math.hypot(ball.vx, ball.vy);
        ball.x += nx * (min - d); ball.y += ny * (min - d);
        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) { ball.vx -= (1 + params.ballBounce) * vn * nx; ball.vy -= (1 + params.ballBounce) * vn * ny; }
        if (bs >= params.ballKillSpeed && c.ballCool <= 0) { hit = true; c.ballCool = 0.4; }
      }
    }
    if (hit) {
      c.hp--;
      c.reload = Math.max(c.reload, 0.6); // the turret is shaken
      c.charge = 0;
      state.events.push({ type: 'cocoonHit', id: c.id, x: c.x, y: c.y, hp: c.hp });
    }
    if (hit && c.hp <= 0) {
      c.alive = false;
      state.events.push({ type: 'cocoon', id: c.id, x: c.x, y: c.y });
      // The spider inside drops out from above and lands on its own.
      const top = c.z + params.spiderDrop;
      const sp = makeSpider(state, c.x, c.y, {
        type: 'spider', mode: 'drop', z: top, air: true, vz: 0, fallFrom: top, cooldown: 0.6,
      });
      state.events.push({ type: 'spiderDrop', id: sp.id, x: c.x, y: c.y });
      continue;
    }
    c.reload = Math.max(0, c.reload - dt);
    const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy);
    const muzzle = c.z + 0.5;
    c.sees = !state.dead && d <= params.turretRange && Math.abs(p.z - c.z) < 1.5
      && lineOfSight(state.map, c.x, c.y, p.x, p.y, Math.max(c.z, p.z));
    if (!c.sees) { c.charge = 0; continue; }
    const want = Math.atan2(dy, dx);
    let diff = Math.atan2(Math.sin(want - c.aim), Math.cos(want - c.aim));
    const turn = Math.sign(diff) * Math.min(Math.abs(diff), params.turretTurn * dt);
    c.aim += turn; diff -= turn;
    if (c.reload > 0 || Math.abs(diff) > 0.2) { c.charge = 0; continue; }
    c.charge += dt;
    if (c.charge < params.turretCharge) continue;
    const ux = Math.cos(c.aim), uy = Math.sin(c.aim);
    state.webs.push({
      id: state.nextId++, from: c.id, x: c.x + ux * 0.4, y: c.y + uy * 0.4, z: muzzle,
      vx: ux * params.webSpeed, vy: uy * params.webSpeed, travel: 0, px: c.x, py: c.y,
    });
    state.events.push({ type: 'shoot', id: c.id, x: c.x, y: c.y });
    c.charge = 0;
    c.reload = params.turretReload * (0.8 + rand(state) * 0.4);
  }
}

// Webs fly straight; they stick to walls and higher ground, drop after their
// range, and wrap the player on contact (not during a dash).
function stepWebs(state, params, dt, dashing) {
  const p = state.player;
  state.webs = state.webs.filter((w) => {
    w.px = w.x; w.py = w.y;
    w.x += w.vx * dt; w.y += w.vy * dt;
    w.travel += Math.hypot(w.vx, w.vy) * dt;
    const tx = Math.floor(w.x), ty = Math.floor(w.y);
    if (isSolid(state.map, tx, ty) || groundLevel(state.map, w.x, w.y) > w.z) {
      state.events.push({ type: 'webSplat', x: w.x, y: w.y, z: w.z });
      return false;
    }
    if (w.travel > params.webRange) return false;
    if (!dashing && !state.dead && Math.abs(p.z + 0.4 - w.z) < 0.9
      && Math.hypot(w.x - p.x, w.y - p.y) < params.radius + params.webRadius) {
      p.webbed = params.webDuration;
      state.events.push({ type: 'webbed', x: p.x, y: p.y });
      return false;
    }
    return true;
  });
}

// ---- dung beetle: a ball with momentum ---------------------------------------

// Keep beetle and ball from overlapping. The beetle gives way; if a wall
// stops it, the ball gives way instead.
function separate(map, p, b, gap, params) {
  for (let k = 0; k < 3; k++) {
    const dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy);
    if (d >= gap - 1e-9) return;
    const ux = d > 1e-9 ? dx / d : -p.faceX, uy = d > 1e-9 ? dy / d : -p.faceY;
    p.x += ux * (gap - d); p.y += uy * (gap - d);
    move(map, p, { vx: 0, vy: 0 }, 0, params.radius);
    const d2 = Math.hypot(p.x - b.x, p.y - b.y);
    if (d2 < gap - 1e-9) {
      b.x -= ux * (gap - d2); b.y -= uy * (gap - d2);
      move(map, b, { vx: 0, vy: 0 }, 0, params.ballRadius);
    }
  }
}

// Close enough to the ball, on the same floor, to work it.
function atBall(p, params) {
  const b = p.ball;
  return Math.hypot(b.x - p.x, b.y - p.y) <= params.radius + params.ballRadius + params.ballEngage
    && Math.abs(b.z - p.z) < SAME_FLOOR && !p.air && !b.air;
}

// Shortest walk (tiles, using the same walk-and-drop rules as movement) from
// tile (sx, sy) to (gx, gy). Returns the tiles from start to goal, or null.
export function findPath(map, sx, sy, gx, gy) {
  const w = map.w, h = map.h, start = sy * w + sx, goal = gy * w + gx;
  if (sx < 0 || sy < 0 || gx < 0 || gy < 0 || sx >= w || gx >= w || sy >= h || gy >= h) return null;
  const prev = new Int32Array(w * h).fill(-1);
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cur === goal) break;
    const x = cur % w, y = (cur - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, ni = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || prev[ni] !== -1) continue;
      if (!canPass(map, x, y, nx, ny)) continue;
      prev[ni] = cur; queue.push(ni);
    }
  }
  if (prev[goal] === -1) return null;
  const path = [];
  for (let i = goal; ; i = prev[i]) { path.push([i % w, Math.floor(i / w)]); if (i === start) break; }
  return path.reverse();
}

// Next point for the beetle on its way back to the ball (cached per tile pair).
function pathTarget(state, p, b) {
  const sx = Math.floor(p.x), sy = Math.floor(p.y), gx = Math.floor(b.x), gy = Math.floor(b.y);
  if (sx === gx && sy === gy) return { x: b.x, y: b.y };
  const key = `${sx},${sy}>${gx},${gy}`;
  if (p.pathKey !== key) { p.pathKey = key; p.path = findPath(state.map, sx, sy, gx, gy); }
  if (!p.path || p.path.length < 2) return null;
  const [nx, ny] = p.path[1];
  return { x: nx + 0.5, y: ny + 0.5 };
}

function touchingBall(p, params) {
  const b = p.ball;
  return Math.hypot(b.x - p.x, b.y - p.y) <= params.radius + params.ballRadius + 0.12
    && Math.abs(b.z - p.z) < SAME_FLOOR;
}

// Dash next to the ball: kick it away from the beetle. Returns true if kicked.
function kickBall(state, params) {
  const p = state.player, b = p.ball;
  if (!touchingBall(p, params)) return false;
  const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const along = b.vx * ux + b.vy * uy;
  const add = Math.max(0, params.ballKick - along);
  b.vx += ux * add; b.vy += uy * add;
  state.events.push({ type: 'kick', x: b.x, y: b.y });
  return true;
}

// The beetle runs to the spot behind the ball (opposite the direction it
// wants to go) and pushes from there. The ball accelerates slowly, keeps
// rolling when the beetle lets go, and bounces off walls and cliffs.
function stepBall(state, dir, params, dt, topSpeed) {
  const p = state.player, b = p.ball, map = state.map;
  const gap = params.radius + params.ballRadius;
  // Rolling friction.
  let sp = Math.hypot(b.vx, b.vy);
  if (sp > 0) { const ns = Math.max(0, sp - params.ballDecel * dt); b.vx *= ns / sp; b.vy *= ns / sp; sp = ns; }
  // Push when touching the ball from behind.
  if (dir.mag > 0 && touchingBall(p, params)) {
    const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy) || 1;
    const align = (dx / d) * (dir.x / dir.mag) + (dy / d) * (dir.y / dir.mag);
    if (align > 0.6) {
      const slow = p.webbed > 0 ? params.webSlow : 1;
      b.vx += (dx / d) * params.ballPush * slow * dir.mag * dt;
      b.vy += (dy / d) * params.ballPush * slow * dir.mag * dt;
      const s2 = Math.hypot(b.vx, b.vy), cap = params.ballMax * (p.overheated ? params.overheatSpeed : 1) * slow;
      if (s2 > cap) { b.vx *= cap / s2; b.vy *= cap / s2; }
    }
  }
  // Roll; a wall contact reflects the blocked part of the velocity.
  b.pz = b.z;
  const before = { vx: b.vx, vy: b.vy };
  move(map, b, b, dt, params.ballRadius);
  const ballFell = settle(map, b, dt, params, params.ballRadius);
  if (ballFell >= 0.5) state.events.push({ type: 'land', who: 'ball', x: b.x, y: b.y, height: ballFell });
  b.vx -= params.ballBounce * (before.vx - b.vx);
  b.vy -= params.ballBounce * (before.vy - b.vy);
  if (!atBall(p, params)) {
    // Away from its ball (or on another floor): you steer the beetle like any
    // bug. Let go and it finds its own way back to the ball.
    let wantX = 0, wantY = 0;
    if (dir.mag > 0) { wantX = dir.x * topSpeed; wantY = dir.y * topSpeed; } else {
      const wp = pathTarget(state, p, b);
      if (wp) {
        const dx = wp.x - p.x, dy = wp.y - p.y, d = Math.hypot(dx, dy) || 1;
        wantX = (dx / d) * topSpeed; wantY = (dy / d) * topSpeed;
      }
    }
    const moving = wantX || wantY;
    const grip = p.air ? params.airControl : 1;
    [p.vx, p.vy] = approach(p.vx, p.vy, wantX, wantY, (moving ? params.accel : params.decel) * grip * dt);
    const vl = Math.hypot(p.vx, p.vy);
    if (vl > 0.2) { p.faceX = p.vx / vl; p.faceY = p.vy / vl; }
    return;
  }
  // The beetle heads for the spot behind the ball.
  let aimX = 0, aimY = 0;
  if (dir.mag > 0) { aimX = dir.x / dir.mag; aimY = dir.y / dir.mag; }
  else if (sp > 0.2) { aimX = b.vx / sp; aimY = b.vy / sp; }
  let wantX = 0, wantY = 0;
  if (aimX || aimY) {
    const tx = b.x - aimX * gap, ty = b.y - aimY * gap;
    wantX = b.vx + (tx - p.x) * 10; wantY = b.vy + (ty - p.y) * 10;
    const ws = Math.hypot(wantX, wantY), cap = Math.max(topSpeed, params.beetleSpeed);
    if (ws > cap) { wantX *= cap / ws; wantY *= cap / ws; }
  }
  [p.vx, p.vy] = approach(p.vx, p.vy, wantX, wantY, params.accel * dt);
  // Face the ball.
  const fx = b.x - p.x, fy = b.y - p.y, fl = Math.hypot(fx, fy);
  if (fl > 1e-6) { p.faceX = fx / fl; p.faceY = fy / fl; }
}

// Vents release a spider when their timer runs out, if there is room and
// the player isn't standing on top of them.
function stepVents(state, params, dt) {
  const p = state.player;
  for (const v of state.vents) {
    v.timer -= dt;
    if (v.timer > 0) continue;
    const alive = state.critters.filter((c) => c.alive && c.type === 'stainer').length;
    if (alive >= params.maxSpiders || dist(v, p) < params.ventSafe) { v.timer = 1; continue; }
    const c = makeSpider(state, v.x, v.y, {
      mode: 'emerge', stateTime: params.emergeTime, stateTotal: params.emergeTime,
    });
    const a = rand(state) * Math.PI * 2;
    c.dirX = Math.cos(a); c.dirY = Math.sin(a);
    state.events.push({ type: 'spawn', id: c.id, x: v.x, y: v.y });
    v.timer = params.ventMin + rand(state) * (params.ventMax - params.ventMin);
  }
}

// Spider from a cocoon: drops, then hunts alone. Stalks toward the player,
// winds up briefly when close, lunges, recovers. Returns the wanted velocity.
function spiderBrain(state, c, params, dt, dx, dy, d) {
  const p = state.player;
  const sameFloor = Math.abs(c.z - p.z) < SAME_FLOOR;
  if (c.mode === 'drop') {
    if (!c.air) { c.mode = 'stalk'; c.timer = 0; }
    return [c.vx, c.vy, 0];
  }
  if (c.mode === 'swindup') {
    c.dirX = -dx / d; c.dirY = -dy / d;
    c.stateTime -= dt;
    if (c.stateTime <= 0) {
      c.mode = 'slunge'; c.stateTime = params.spiderLungeTime; c.hitDone = false;
      c.lungeX = c.dirX; c.lungeY = c.dirY;
    }
    return [0, 0, params.critterAccel];
  }
  if (c.mode === 'slunge') {
    c.vx = c.lungeX * params.spiderLungeSpeed; c.vy = c.lungeY * params.spiderLungeSpeed;
    c.stateTime -= dt;
    if (c.stateTime <= 0) { c.mode = 'stalk'; c.cooldown = params.spiderCooldown; }
    return [c.vx, c.vy, Infinity];
  }
  // Stalking.
  if (!state.dead && sameFloor && d < params.spiderLungeRange && c.cooldown <= 0) {
    c.mode = 'swindup'; c.stateTime = params.spiderWindup; c.stateTotal = params.spiderWindup;
    return [0, 0, params.critterAccel];
  }
  if (!state.dead && d < params.spiderAggro) {
    c.dirX = -dx / d; c.dirY = -dy / d;
    return [c.dirX * params.spiderSpeed, c.dirY * params.spiderSpeed, params.critterAccel];
  }
  c.timer -= dt;
  if (c.timer <= 0) {
    const a = rand(state) * Math.PI * 2;
    c.dirX = Math.cos(a); c.dirY = Math.sin(a); c.timer = 1.5 + rand(state) * 1.5;
  }
  return [c.dirX * params.critterSpeed, c.dirY * params.critterSpeed, params.critterAccel];
}

// Cotton stainers: alone they wander, flee, or walk to a partner. Two free spiders
// standing next to each other near the player wind up together, lunge, and
// are thrown apart afterwards, then can't pair again for attackCooldown.
// A dashing player kills any spider it touches.
function stepSpiders(state, params, dt, dashing) {
  const p = state.player;
  const contact = params.radius + params.critterRadius;
  for (const c of state.critters) {
    c.px = c.x; c.py = c.y; c.pz = c.z;
    if (!c.alive) { c.deadTime += dt; continue; }
    c.cooldown = Math.max(0, c.cooldown - dt);
  }
  // Old corpses leave the simulation (the renderer keeps a husk on the floor).
  state.critters = state.critters.filter((c) => {
    if (c.alive || c.deadTime < params.corpseTime) return true;
    state.events.push({ type: 'corpse', id: c.id, x: c.x, y: c.y });
    return false;
  });

  // Pair up, in list order so the result is deterministic.
  state.critters.forEach((c) => {
    if (!canPair(c) || dist(c, p) > params.aggroRange) return;
    const o = nearestPartner(state, c, params.pairRange);
    if (!o) return;
    for (const [a, partner, role] of [[c, o.id, 0], [o, c.id, 1]]) {
      a.mode = 'windup'; a.stateTime = params.windup; a.stateTotal = params.windup;
      a.partner = partner; a.role = role; a.hitDone = false;
    }
  });

  for (const c of state.critters) {
    if (!c.alive) continue;
    const dx = c.x - p.x, dy = c.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    let tx = 0, ty = 0, accel = params.critterAccel;

    if (c.type === 'spider') {
      [tx, ty, accel] = spiderBrain(state, c, params, dt, dx, dy, d);
    } else if (c.mode === 'emerge') {
      c.stateTime -= dt;
      if (c.stateTime <= 0) { c.mode = 'wander'; c.cooldown = params.spawnCooldown; c.timer = 0; }
    } else if (c.mode === 'windup') {
      c.dirX = -dx / d; c.dirY = -dy / d; // face the player
      c.stateTime -= dt;
      if (c.stateTime <= 0) {
        c.mode = 'lunge'; c.stateTime = params.lungeTime;
        c.lungeX = c.dirX; c.lungeY = c.dirY;
      }
    } else if (c.mode === 'lunge') {
      c.vx = c.lungeX * params.lungeSpeed; c.vy = c.lungeY * params.lungeSpeed;
      tx = c.vx; ty = c.vy; accel = Infinity;
      c.stateTime -= dt;
      if (c.stateTime <= 0) {
        // Thrown off to opposite sides, partly backwards.
        const side = c.role ? -1 : 1;
        let ux = -c.lungeY * side * 0.8 - c.lungeX * 0.6;
        let uy = c.lungeX * side * 0.8 - c.lungeY * 0.6;
        const ul = Math.hypot(ux, uy) || 1;
        ux /= ul; uy /= ul;
        c.mode = 'thrown'; c.stateTime = params.thrownTime;
        c.vx = ux * params.thrownSpeed; c.vy = uy * params.thrownSpeed;
        accel = params.critterAccel; // the lunge's instant velocity must not cancel the throw
      }
    } else if (c.mode === 'thrown') {
      c.stateTime -= dt;
      if (c.stateTime <= 0) {
        c.mode = 'wander'; c.partner = -1; c.cooldown = params.attackCooldown; c.timer = 0;
      }
    } else {
      // Wander mode.
      const partner = c.cooldown <= 0 && d < params.aggroRange ? nearestPartner(state, c, params.regroupRange) : null;
      if (partner) {
        const px = partner.x - c.x, py = partner.y - c.y, pl = Math.hypot(px, py) || 1;
        c.dirX = px / pl; c.dirY = py / pl; c.fleeing = false; c.timer = 0.2;
        tx = c.dirX * params.regroupSpeed; ty = c.dirY * params.regroupSpeed;
      } else {
        let speed;
        if (d < params.critterFear) {
          c.fleeing = true;
          c.dirX = dx / d; c.dirY = dy / d;
          speed = params.critterFleeSpeed;
          c.timer = 0.4; // keep running a little after leaving the fear radius
        } else {
          c.timer -= dt;
          if (c.timer <= 0) {
            c.fleeing = false;
            if (rand(state) < 0.3) {
              c.dirX = 0; c.dirY = 0; // pause
            } else {
              const a = rand(state) * Math.PI * 2;
              c.dirX = Math.cos(a); c.dirY = Math.sin(a);
            }
            c.timer = 0.8 + rand(state) * 1.8;
          }
          speed = c.fleeing ? params.critterFleeSpeed : params.critterSpeed;
        }
        tx = c.dirX * speed; ty = c.dirY * speed;
      }
    }

    if (c.mode !== 'lunge' && c.mode !== 'slunge') {
      if (c.mode === 'windup' || c.mode === 'thrown' || c.mode === 'emerge' || c.mode === 'swindup') { tx = 0; ty = 0; }
      [c.vx, c.vy] = approach(c.vx, c.vy, tx, ty, accel * dt * (c.air ? params.airControl : 1));
    }
    const want = Math.hypot(c.vx, c.vy);
    move(state.map, c, { vx: c.vx, vy: c.vy }, dt, params.critterRadius);
    const cFell = settle(state.map, c, dt, params, params.critterRadius);
    if (cFell >= 0.5) state.events.push({ type: 'land', who: c.id, x: c.x, y: c.y, height: cFell });
    // Pressed against a wall while wandering: pick a new direction next step.
    if (c.mode === 'wander' && want > 0.2 && Math.hypot(c.vx, c.vy) < want * 0.3 && !c.fleeing) c.timer = 0;

    const sameFloor = Math.abs(c.z - p.z) < SAME_FLOOR;
    if (dashing && sameFloor && dist(c, p) < contact + params.killMargin) { killSpider(state, c); continue; }
    if (p.ball) {
      // A fast ball squashes whatever it rolls over.
      const b = p.ball, bs = Math.hypot(b.vx, b.vy);
      if (bs >= params.ballKillSpeed && Math.abs(c.z - b.z) < SAME_FLOOR && dist(c, b) < params.ballRadius + params.critterRadius) {
        killSpider(state, c, b.vx / bs, b.vy / bs); continue;
      }
    }
    if ((c.mode === 'lunge' || c.mode === 'slunge') && !c.hitDone && sameFloor && dist(c, p) < contact + 0.05) {
      c.hitDone = true;
      hitPlayer(state, c, params);
    }
  }
}

// Smallest gap between a circle and anything that blocks it (walls, and
// tiles at another height); negative = overlap.
export function wallClearance(state, r, p = state.player) {
  let best = Infinity;
  const ox = Math.floor(p.x), oy = Math.floor(p.y);
  for (let ty = oy - 2; ty <= oy + 2; ty++) {
    for (let tx = ox - 2; tx <= ox + 2; tx++) {
      const cx = Math.min(Math.max(p.x, tx), tx + 1);
      const cy = Math.min(Math.max(p.y, ty), ty + 1);
      if (!blocks(state.map, p, tx, ty, cx, cy)) continue;
      const inside = p.x > tx && p.x < tx + 1 && p.y > ty && p.y < ty + 1;
      const d = inside ? -1 : Math.hypot(p.x - cx, p.y - cy);
      best = Math.min(best, d - r);
    }
  }
  return best;
}
