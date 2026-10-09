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
};

export function parseLevel(level) {
  const rows = level.map;
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const solid = new Uint8Array(w * h);
  const shards = [];
  let spawn = { x: w / 2, y: h / 2 };
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const c = rows[ty][tx] ?? '#';
      if (c === '#') solid[ty * w + tx] = 1;
      else if (c === 'P') spawn = { x: tx + 0.5, y: ty + 0.5 };
      else if (c === '*') shards.push({ x: tx + 0.5, y: ty + 0.5 });
    }
  }
  return { name: level.name, w, h, solid, shards, spawn };
}

export function isSolid(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
  return map.solid[ty * map.w + tx] === 1;
}

export function createState(level) {
  const map = parseLevel(level);
  return {
    map,
    player: {
      x: map.spawn.x, y: map.spawn.y,
      px: map.spawn.x, py: map.spawn.y, // position before the last step, for render interpolation
      vx: 0, vy: 0,
      faceX: Math.SQRT1_2, faceY: Math.SQRT1_2,
      dashTime: 0, dashCooldown: 0, dashBuffer: 0,
      dashX: 0, dashY: 0,
    },
    shards: map.shards.map((s) => ({ x: s.x, y: s.y, taken: false })),
    collected: 0,
    time: 0,
    won: false,
    tick: 0,
  };
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
  const r = params.radius;
  p.px = p.x; p.py = p.y;

  const dir = inputToWorld(input.x || 0, input.y || 0, params.diagonalMode);
  if (dir.mag > 0) {
    p.faceX = dir.x / dir.mag;
    p.faceY = dir.y / dir.mag;
  }

  p.dashCooldown = Math.max(0, p.dashCooldown - dt);
  p.dashBuffer = Math.max(0, p.dashBuffer - dt);
  if (input.dash) p.dashBuffer = params.dashBuffer;

  if (p.dashBuffer > 0 && p.dashCooldown <= 0 && p.dashTime <= 0) {
    p.dashX = p.faceX; p.dashY = p.faceY;
    p.dashTime = params.dashDuration;
    p.dashCooldown = params.dashCooldown;
    p.dashBuffer = 0;
  }

  let mvx, mvy;
  if (p.dashTime > 0) {
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
      dir.x * params.maxSpeed, dir.y * params.maxSpeed,
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
    }
  }

  if (!state.won) {
    state.time += dt;
    if (state.collected === state.shards.length) state.won = true;
  }
  state.tick++;
  return state;
}

// Smallest gap between the player circle and any wall; negative = overlap.
export function wallClearance(state, r) {
  const p = state.player;
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
