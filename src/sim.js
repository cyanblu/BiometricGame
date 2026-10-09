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

export function parseLevel(level) {
  const rows = level.map;
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const solid = new Uint8Array(w * h);
  const shards = [];
  const critters = [];
  const vents = [];
  let spawn = { x: w / 2, y: h / 2 };
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const c = rows[ty][tx] ?? '#';
      if (c === '#') solid[ty * w + tx] = 1;
      else if (c === 'P') spawn = { x: tx + 0.5, y: ty + 0.5 };
      else if (c === '*') shards.push({ x: tx + 0.5, y: ty + 0.5, big: false });
      else if (c === 'B') shards.push({ x: tx + 0.5, y: ty + 0.5, big: true });
      else if (c === 'V') vents.push({ x: tx + 0.5, y: ty + 0.5 });
      else if (c === 'b' || c === 's') critters.push({ x: tx + 0.5, y: ty + 0.5 });
    }
  }
  return { name: level.name, w, h, solid, shards, critters, vents, spawn };
}

export function isSolid(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
  return map.solid[ty * map.w + tx] === 1;
}

// A new spider. Spiders have ids because they come and go (vents, corpses).
export function makeSpider(state, x, y, extra = {}) {
  const c = {
    id: state.nextId++,
    x, y, px: x, py: y, vx: 0, vy: 0,
    dirX: 0, dirY: 0, timer: 0, fleeing: false,
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
      x: map.spawn.x, y: map.spawn.y,
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
    },
    shards: map.shards.map((s) => ({ x: s.x, y: s.y, big: s.big, taken: false })),
    collected: 0,
    time: 0,
    won: false,
    dead: false,
    tick: 0,
  };
  map.critters.forEach((c, i) => makeSpider(state, c.x, c.y, { timer: 0.3 * i }));
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
        if (!isSolid(map, tx, ty)) continue;
        const cx = Math.min(Math.max(p.x, tx), tx + 1);
        const cy = Math.min(Math.max(p.y, ty), ty + 1);
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

// input: { x, y } screen-space stick in [-1, 1], dash: true on the step the
// button went down.
export function step(state, input, params = DEFAULT_PARAMS, dt = STEP) {
  const p = state.player;
  if (state.dead) {
    // Frozen: keep interpolation still, change nothing else.
    p.px = p.x; p.py = p.y;
    for (const c of state.critters) { c.px = c.x; c.py = c.y; }
    return state;
  }
  const r = params.radius;
  p.px = p.x; p.py = p.y;

  p.stun = Math.max(0, p.stun - dt);
  p.invuln = Math.max(0, p.invuln - dt);
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
    p.dashTime = params.dashDuration;
    p.dashCooldown = params.dashCooldown;
    p.dashBuffer = 0;
    p.heat = Math.min(1, p.heat + params.dashHeat);
    if (p.heat >= 1) p.overheated = true;
  } else {
    p.heat = Math.max(0, p.heat - params.heatCool * dt);
    if (p.overheated && p.heat <= params.overheatRecover) p.overheated = false;
  }
  const topSpeed = params.maxSpeed * (p.overheated ? params.overheatSpeed : 1);

  let mvx, mvy;
  const dashing = p.dashTime > 0;
  if (dashing) {
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
    [p.vx, p.vy] = approach(
      p.vx, p.vy,
      dir.x * topSpeed, dir.y * topSpeed,
      (has ? params.accel : params.decel) * dt,
    );
    mvx = p.vx; mvy = p.vy;
  }

  move(state.map, p, { vx: mvx, vy: mvy }, dt, r);

  const reach = r + params.pickupRange;
  for (const s of state.shards) {
    if (s.taken) continue;
    if (Math.hypot(s.x - p.x, s.y - p.y) <= reach) {
      s.taken = true;
      state.collected++;
      const gain = s.big ? params.bigCharge : params.smallCharge;
      p.charges = Math.min(params.maxCharges, p.charges + gain);
      state.events.push({ type: 'pickup', x: s.x, y: s.y, big: s.big });
    }
  }

  stepVents(state, params, dt);
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
const canPair = (c) => c.alive && c.mode === 'wander' && c.cooldown <= 0;

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

function killSpider(state, c) {
  const p = state.player;
  c.alive = false; c.mode = 'dead'; c.vx = 0; c.vy = 0; c.deadTime = 0;
  state.kills++;
  state.events.push({ type: 'kill', id: c.id, x: c.x, y: c.y, dirX: p.dashX, dirY: p.dashY });
}

// Vents release a spider when their timer runs out, if there is room and
// the player isn't standing on top of them.
function stepVents(state, params, dt) {
  const p = state.player;
  for (const v of state.vents) {
    v.timer -= dt;
    if (v.timer > 0) continue;
    const alive = state.critters.filter((c) => c.alive).length;
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

// Spiders: alone they wander, flee, or walk to a partner. Two free spiders
// standing next to each other near the player wind up together, lunge, and
// are thrown apart afterwards, then can't pair again for attackCooldown.
// A dashing player kills any spider it touches.
function stepSpiders(state, params, dt, dashing) {
  const p = state.player;
  const contact = params.radius + params.critterRadius;
  for (const c of state.critters) {
    c.px = c.x; c.py = c.y;
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

    if (c.mode === 'emerge') {
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

    if (c.mode !== 'lunge') {
      if (c.mode === 'windup' || c.mode === 'thrown' || c.mode === 'emerge') { tx = 0; ty = 0; }
      [c.vx, c.vy] = approach(c.vx, c.vy, tx, ty, accel * dt);
    }
    const want = Math.hypot(c.vx, c.vy);
    move(state.map, c, { vx: c.vx, vy: c.vy }, dt, params.critterRadius);
    // Pressed against a wall while wandering: pick a new direction next step.
    if (c.mode === 'wander' && want > 0.2 && Math.hypot(c.vx, c.vy) < want * 0.3 && !c.fleeing) c.timer = 0;

    if (dashing && dist(c, p) < contact + params.killMargin) { killSpider(state, c); continue; }
    if (c.mode === 'lunge' && !c.hitDone && dist(c, p) < contact + 0.05) {
      c.hitDone = true;
      hitPlayer(state, c, params);
    }
  }
}

// Smallest gap between the player circle and any wall; negative = overlap.
export function wallClearance(state, r, p = state.player) {
  let best = Infinity;
  const x0 = Math.floor(p.x) - 2, x1 = Math.floor(p.x) + 2;
  const y0 = Math.floor(p.y) - 2, y1 = Math.floor(p.y) + 2;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!isSolid(state.map, tx, ty)) continue;
      const cx = Math.min(Math.max(p.x, tx), tx + 1);
      const cy = Math.min(Math.max(p.y, ty), ty + 1);
      const inside = p.x > tx && p.x < tx + 1 && p.y > ty && p.y < ty + 1;
      const d = inside ? -1 : Math.hypot(p.x - cx, p.y - cy);
      best = Math.min(best, d - r);
    }
  }
  return best;
}
