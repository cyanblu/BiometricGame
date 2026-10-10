// Levels. A level is { name, map, heights, biomes } as rows of characters:
//   map:     '#' wall, '.' floor, 'P' player spawn, '*' battery cell (+3),
//            'B' big red battery (+9), 'V' vent (spawns cotton stainers),
//            'O' cocoon with a web turret, 'b' or 's' cotton stainer,
//            'H' shelter (sleep through the rain), 'n' gnat nest.
//   heights: '0'-'9' flat level; ramps rise toward '>' +x, '<' -x, 'v' +y,
//            '^' -y; stairs toward 'E' +x, 'W' -x, 'S' +y, 'N' -y. A slope
//            starts at the level of the tile on its low side, ends one higher.
//   biomes:  'y' pump yard, 'g' overgrown garden, 'f' rust foundry,
//            'd' flooded drains, 'h' hive.
// The arena is generated from a seed: pure and deterministic, so the same
// seed always gives the same map. It is validated (everything reachable, no
// dead ends) and regenerated with the next seed if a layout fails.
import { parseLevel, canPass } from './sim.js';

export const BIOMES = {
  y: { name: 'Pump Yard' },
  g: { name: 'Overgrown Garden' },
  f: { name: 'Rust Foundry' },
  d: { name: 'Flooded Drains' },
  h: { name: 'The Hive' },
};

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth value noise in [0, 1) on a coarse grid, for organic biome borders.
function valueNoise(seed, cell) {
  const h = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + seed * 17.3) * 43758.5453;
    return s - Math.floor(s);
  };
  return (x, y) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    const fx = x / cell - gx, fy = y / cell - gy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h(gx, gy), b = h(gx + 1, gy), c = h(gx, gy + 1), d = h(gx + 1, gy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

// Per-biome flavour for the generator.
const STYLE = {
  y: { plateaus: 2, walls: 0.012, stairs: 0.5, small: 6, big: 1, vents: 1, cocoons: 0, shelters: 1, nests: 1 },
  g: { plateaus: 4, walls: 0.02, stairs: 0.2, small: 6, big: 1, vents: 3, cocoons: 2, shelters: 1, nests: 3 },
  f: { plateaus: 4, walls: 0.035, stairs: 0.8, small: 6, big: 2, vents: 3, cocoons: 2, shelters: 1, nests: 1 },
  d: { plateaus: 4, walls: 0.025, stairs: 0.7, small: 6, big: 1, vents: 3, cocoons: 2, shelters: 1, nests: 2 },
  h: { plateaus: 4, walls: 0.025, stairs: 0.4, small: 6, big: 2, vents: 3, cocoons: 4, shelters: 1, nests: 2 },
};

export function generateArena(seed = 7, size = 80) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lvl = tryArena(seed + attempt * 101, size);
    if (lvl) return lvl;
  }
  throw new Error('could not generate a valid arena');
}

function tryArena(seed, W) {
  const H = W, rnd = seededRandom(seed), cx = W / 2, cy = H / 2;
  const tiles = Array.from({ length: H }, () => Array(W).fill('.'));
  const hgt = Array.from({ length: H }, () => Array(W).fill('0'));
  const bio = Array.from({ length: H }, () => Array(W).fill('y'));
  const n1 = valueNoise(seed, 9), n2 = valueNoise(seed + 5, 5);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  // Biomes: the yard in the middle, four quarters around it, wobbly borders.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wob = (n1(x, y) - 0.5) * 9 + (n2(x, y) - 0.5) * 4;
      const d = Math.hypot(x - cx, y - cy) + wob;
      if (d < W * 0.17) { bio[y][x] = 'y'; continue; }
      const a = Math.atan2(y - cy, x - cx) + (n2(x + 40, y) - 0.5) * 0.7;
      const q = ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4; // 0 east, 1 south, 2 west, 3 north
      bio[y][x] = 'fhgd'[q];
    }
  }
  for (let i = 0; i < W; i++) { tiles[0][i] = tiles[H - 1][i] = tiles[i][0] = tiles[i][W - 1] = '#'; }

  // Plateaus (level 1), some with a level-2 deck, joined by ramps or stairs.
  const used = Array.from({ length: H }, () => Array(W).fill(false));
  const protect = Array.from({ length: H }, () => Array(W).fill(false)); // no walls or items here
  const near = (x, y, r) => Math.hypot(x - cx, y - cy) < r;
  const slopeChar = (dx, dy, stairs) => (stairs
    ? (dx > 0 ? 'E' : dx < 0 ? 'W' : dy > 0 ? 'S' : 'N')
    : (dx > 0 ? '>' : dx < 0 ? '<' : dy > 0 ? 'v' : '^'));
  // A 2-wide connector on one side of rect (x0, y0, w, h), rising into it.
  const connector = (x0, y0, w, h, level, stairs) => {
    const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let i = sides.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sides[i], sides[j]] = [sides[j], sides[i]]; }
    for (const [sxd, syd] of sides) {
      const dx = -sxd, dy = -syd; // the direction the slope rises (into the rect)
      const along = sxd ? h : w;
      if (along < 4) continue;
      const k = ri(1, along - 3);
      const cells = [0, 1].map((j) => (sxd
        ? [sxd < 0 ? x0 - 1 : x0 + w, y0 + k + j]
        : [x0 + k + j, syd < 0 ? y0 - 1 : y0 + h]));
      const ok = cells.every(([x, y]) => {
        const lx = x - dx, ly = y - dy;
        return x > 1 && y > 1 && x < W - 2 && y < H - 2 && lx > 0 && ly > 0 && lx < W - 1 && ly < H - 1
          && hgt[y][x] === String(level - 1) && hgt[ly][lx] === String(level - 1) && tiles[y][x] === '.';
      });
      if (!ok) continue;
      for (const [x, y] of cells) {
        hgt[y][x] = slopeChar(dx, dy, stairs);
        protect[y][x] = protect[y - dy][x - dx] = protect[y + dy][x + dx] = true;
      }
      return true;
    }
    return false;
  };
  const fill = (x0, y0, w, h, v) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) hgt[y][x] = v; };
  for (const b of 'ygfdh') {
    const st = STYLE[b];
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < st.plateaus; tries++) {
      const w = ri(5, 10), h = ri(5, 10), x0 = ri(3, W - w - 4), y0 = ri(3, H - h - 4);
      let ok = true;
      for (let y = y0 - 3; y < y0 + h + 3 && ok; y++) {
        for (let x = x0 - 3; x < x0 + w + 3 && ok; x++) {
          if (used[y]?.[x] || (y >= y0 && y < y0 + h && x >= x0 && x < x0 + w && bio[y][x] !== b)) ok = false;
        }
      }
      if (!ok || near(x0 + w / 2, y0 + h / 2, 8)) continue;
      fill(x0, y0, w, h, '1');
      const stairs = () => rnd() < st.stairs;
      if (!connector(x0, y0, w, h, 1, stairs())) { fill(x0, y0, w, h, '0'); continue; }
      if (rnd() < 0.6) connector(x0, y0, w, h, 1, stairs());
      for (let y = y0 - 2; y < y0 + h + 2; y++) for (let x = x0 - 2; x < x0 + w + 2; x++) used[y][x] = true;
      // A higher deck on bigger plateaus, set two tiles in from the edge.
      if (w >= 7 && h >= 7 && rnd() < 0.55) {
        const dx0 = x0 + 2, dy0 = y0 + 2, dw = w - 4, dh = h - 4;
        fill(dx0, dy0, dw, dh, '2');
        if (!connector(dx0, dy0, dw, dh, 2, stairs())) fill(dx0, dy0, dw, dh, '1');
      }
      placed++;
    }
  }

  // Walls: clusters, denser in the industrial biomes; never on slopes or near the spawn.
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      if (rnd() > STYLE[bio[y][x]].walls || near(x, y, 4)) continue;
      const big = rnd() < 0.4;
      for (let yy = y; yy < y + (big ? 2 : 1); yy++) {
        for (let xx = x; xx < x + (big ? 2 : 1); xx++) {
          if (protect[yy][xx] || !/[0-9]/.test(hgt[yy][xx]) || hgt[yy][xx] !== hgt[y][x]) continue;
          tiles[yy][xx] = '#';
        }
      }
    }
  }
  tiles[cy][cx] = 'P';

  // Validate: everything reachable from the spawn can get back to it.
  const def = { name: 'The Sprawl', map: tiles.map((r) => r.join('')), heights: hgt.map((r) => r.join('')), biomes: bio.map((r) => r.join('')) };
  const m = parseLevel(def);
  const flood = (step) => {
    const seen = new Uint8Array(W * H), q = [cy * W + cx];
    seen[q[0]] = 1;
    for (let i = 0; i < q.length; i++) {
      const x = q[i] % W, y = (q[i] - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, ni = ny * W + nx;
        if (seen[ni] || !step(x, y, nx, ny)) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    return seen;
  };
  const fwd = flood((ax, ay, bx, by) => canPass(m, ax, ay, bx, by));
  const back = flood((ax, ay, bx, by) => canPass(m, bx, by, ax, ay));
  for (let i = 0; i < W * H; i++) if (fwd[i] && !back[i]) return null; // a trap: reroll

  // Items on reachable, open, flat tiles, spaced apart.
  const placedAt = [[cx, cy]];
  const free = (x, y, gap) => fwd[y * W + x] && tiles[y][x] === '.' && /[0-9]/.test(hgt[y][x])
    && !protect[y][x] && placedAt.every(([px, py]) => Math.hypot(px - x, py - y) >= gap);
  const put = (b, ch, count, gap, minFromSpawn, preferHigh) => {
    let n = 0;
    for (let tries = 0; tries < 6000 && n < count; tries++) {
      const x = ri(2, W - 3), y = ri(2, H - 3);
      if (bio[y][x] !== b || near(x, y, minFromSpawn) || !free(x, y, gap)) continue;
      if (preferHigh && hgt[y][x] === '0' && rnd() < 0.5) continue;
      tiles[y][x] = ch; placedAt.push([x, y]); n++;
    }
    return n;
  };
  for (const b of 'ygfdh') {
    const st = STYLE[b];
    if (put(b, 'H', st.shelters, 6, 5, false) < st.shelters) return null;
    if (put(b, 'O', st.cocoons, 5, 10, false) < st.cocoons) return null;
    if (put(b, 'V', st.vents, 6, 10, false) < st.vents) return null;
    if (put(b, 'B', st.big, 4, 6, true) < st.big) return null;
    if (put(b, '*', st.small, 4, 3, true) < st.small) return null;
    if (put(b, 'n', st.nests, 5, 6, false) < st.nests) return null;
  }
  return { ...def, seed, map: tiles.map((r) => r.join('')) };
}

export const LEVELS = [generateArena(7, 80)];
