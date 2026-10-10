// Canvas renderer. Reads simulation state, never changes it.
// The world is drawn into a small offscreen canvas at a fixed art resolution
// (one art pixel = `look.pixel` world pixels, whatever the zoom), lit, snapped
// to the palette in src/pixel.js, then scaled up by a whole number without
// smoothing. Zoom only changes that whole-number scale, never the art.
import { TILE_W, TILE_H, isSolid, groundLevel, tileLevelAt, rainLevel } from './sim.js';
import { hipOf, legIK } from './bug.js';
import { COLORS, buildLut, quantize } from './pixel.js';

const C = COLORS;
const WALL_H = 34;
const Z_PX = 36; // world pixels per tile of height
const LEVEL_PX = 24; // world pixels per terrain level
const LEVEL_Z = LEVEL_PX / Z_PX; // one terrain level in rig height units
const HW = TILE_W / 2;
const HH = TILE_H / 2;

export const LOOK_DEFAULTS = { pixel: 2, dither: 6, darkness: 0.55, rain: 0.6, palette: true };

// Stable per-tile noise in [0, 1).
function hash(a, b, k = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export function createRenderer(canvas) {
  const out = canvas.getContext('2d');
  const low = document.createElement('canvas');
  const light = document.createElement('canvas');
  let ctx = low.getContext('2d', { willReadFrequently: true }); // swapped while drawing menu previews
  const lctx = light.getContext('2d');
  const table = buildLut();
  const fx = { particles: [], trail: [], drops: [], rings: [], splashes: [], sheets: [] };
  const grade = { r: 74, g: 90, b: 102 }; // current colour grade, eased toward the biome's
  let lights = [];
  let w = 0, h = 0, dpr = 1;
  let scale = 1; // low-res pixels per world pixel this frame
  let onePx = 1; // one low-res pixel, in world pixels

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const sx = (x, y) => (x - y) * HW;
  const sy = (x, y) => (x + y) * HH;
  // Terrain of the level being drawn; set at the start of every frame.
  let map = null;
  const lvAt = (x, y) => (map ? groundLevel(map, x, y) : 0);
  const liftAt = (x, y) => lvAt(x, y) * LEVEL_PX;
  // Ground offset (rig height units) added by P3; set per creature while drawing it.
  let baseZ = 0;
  const P3 = (x, y, z) => [sx(x, y), sy(x, y) - (z + baseZ) * Z_PX];
  const px = (n) => Math.max(n, onePx);

  function diamond(x, y, lift, inset = 0) {
    const a = x + inset, b = y + inset, e = 1 - inset * 2;
    ctx.beginPath();
    ctx.moveTo(sx(a, b), sy(a, b) - lift);
    ctx.lineTo(sx(a + e, b), sy(a + e, b) - lift);
    ctx.lineTo(sx(a + e, b + e), sy(a + e, b + e) - lift);
    ctx.lineTo(sx(a, b + e), sy(a, b + e) - lift);
    ctx.closePath();
  }

  // Point on a vertical face: u along its edge (0..1), v from its bottom (0) to
  // its top (1). Bottom and top heights (world px) can differ at each end.
  function facePoint(face, u, v) {
    const [x, y] = face.side === 'y' ? [face.tx + u, face.ty + 1] : [face.tx + 1, face.ty + u];
    const b = face.b0 + (face.b1 - face.b0) * u, t = face.t0 + (face.t1 - face.t0) * u;
    return [sx(x, y), sy(x, y) - (b + v * (t - b))];
  }

  // Corner height (world px) of a tile's surface at grid point (gx, gy).
  const cornerPx = (tx, ty, gx, gy) => tileLevelAt(map, tx, ty, gx, gy) * LEVEL_PX;

  // The visible faces (+y and +x sides) of a column whose top edge heights are
  // given by topAt(gx, gy). A face runs down to the neighbour's surface; a
  // wall neighbour hides it.
  function columnFaces(tx, ty, topAt) {
    const faces = [];
    for (const side of ['y', 'x']) {
      const [nx, ny] = side === 'y' ? [tx, ty + 1] : [tx + 1, ty];
      const [g0, g1] = side === 'y' ? [[tx, ty + 1], [tx + 1, ty + 1]] : [[tx + 1, ty], [tx + 1, ty + 1]];
      const outside = nx >= map.w || ny >= map.h;
      if (!outside && isSolid(map, nx, ny)) continue;
      const t0 = topAt(...g0), t1 = topAt(...g1);
      const b0 = outside ? 0 : Math.min(t0, cornerPx(nx, ny, ...g0));
      const b1 = outside ? 0 : Math.min(t1, cornerPx(nx, ny, ...g1));
      if (t0 - b0 < 0.5 && t1 - b1 < 0.5) continue;
      faces.push({ side, tx, ty, b0, b1, t0, t1 });
    }
    return faces;
  }
  function faceQuad(face, u0, u1, v0, v1) {
    const a = facePoint(face, u0, v0), b = facePoint(face, u1, v0);
    const c = facePoint(face, u1, v1), d = facePoint(face, u0, v1);
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.lineTo(...d); ctx.closePath();
  }

  // ---- floor ---------------------------------------------------------------
  // Raised floors are riveted deck plates, so each level reads apart from the
  // concrete yard below. Higher decks are darker grating.
  // Biome of a tile: 0 yard, 1 garden, 2 foundry, 3 drains, 4 hive (sim BIOME_KEYS).
  const biomeAt = (tx, ty) => (map && map.biome ? map.biome[ty * map.w + tx] : 0);

  // Rain World-like depth: low floors sink into a biome-tinted fog.
  const FOG = () => [C.puddle0, C.moss0, C.grime, C.puddle0, C.blood0];
  function fogTile(tx, ty, level) {
    const a = level <= 0 ? 0.2 : level < 2 ? 0.08 : 0;
    if (!a) return;
    diamond(tx, ty, 0);
    ctx.globalAlpha *= a; ctx.fillStyle = FOG()[biomeAt(tx, ty)]; ctx.fill(); ctx.globalAlpha /= a;
  }
  function drawDeck(tx, ty, level) {
    drawDeckTile(tx, ty, level);
    fogTile(tx, ty, level);
  }
  function drawDeckTile(tx, ty, level) {
    const b = biomeAt(tx, ty);
    if (b) { BIOME_DECK[b](tx, ty, level); return; }
    const n = hash(tx, ty, 7);
    diamond(tx, ty, 0);
    ctx.fillStyle = level >= 2 ? C.metal1 : n < 0.5 ? C.metal2 : C.metal1; ctx.fill();
    ctx.strokeStyle = C.metal0; ctx.lineWidth = px(1); ctx.stroke();
    if (level >= 2) {
      // Grating: a lattice of slots.
      ctx.strokeStyle = C.void1;
      for (let k = 1; k < 5; k++) {
        const f = k / 5;
        ctx.beginPath(); ctx.moveTo(sx(tx + f, ty + 0.1), sy(tx + f, ty + 0.1)); ctx.lineTo(sx(tx + f, ty + 0.9), sy(tx + f, ty + 0.9)); ctx.stroke();
      }
    } else {
      diamond(tx, ty, 0, 0.1);
      ctx.strokeStyle = C.metal3; ctx.stroke();
    }
    ctx.fillStyle = C.metal4;
    for (const [a, b] of [[0.14, 0.14], [0.86, 0.14], [0.86, 0.86], [0.14, 0.86]]) {
      ctx.fillRect(sx(tx + a, ty + b) - onePx / 2, sy(tx + a, ty + b) - onePx / 2, onePx, onePx);
    }
    if (hash(tx, ty, 8) < 0.35) floorBlob(tx + 0.3 + hash(tx, ty, 9) * 0.4, ty + 0.3 + hash(tx, ty, 10) * 0.4, 0.14, C.rust0);
    if (hash(tx, ty, 11) < 0.2) floorBlob(tx + 0.2 + hash(tx, ty, 12) * 0.6, ty + 0.2 + hash(tx, ty, 13) * 0.6, 0.1, C.moss1);
  }

  function floorBlob(cx, cy, r, color) {
    const X = sx(cx, cy), Y = sy(cx, cy);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(X, Y, r * HW, r * HH, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawFloor(tx, ty, t) {
    drawFloorTile(tx, ty, t);
    fogTile(tx, ty, 0);
    if (biomeAt(tx, ty) === 1) gardenOrnaments(tx, ty);
  }
  function drawFloorTile(tx, ty, t) {
    const b = biomeAt(tx, ty);
    if (b) { BIOME_FLOOR[b](tx, ty, t); return; }
    const n = hash(tx, ty), v = hash(tx, ty, 1);
    diamond(tx, ty, 0);
    ctx.fillStyle = n < 0.5 ? C.conc1 : C.conc2; ctx.fill();
    ctx.strokeStyle = C.conc0; ctx.lineWidth = px(1); ctx.stroke();
    const cx = tx + 0.3 + hash(tx, ty, 2) * 0.4, cy = ty + 0.3 + hash(tx, ty, 3) * 0.4;
    if (v < 0.12) {
      floorBlob(cx, cy, 0.32, C.puddle0);
      const sh = Math.sin(t * 1.3 + tx) * 0.06;
      ctx.strokeStyle = C.puddle1; ctx.lineWidth = px(1);
      ctx.beginPath();
      ctx.moveTo(sx(cx - 0.15 + sh, cy - 0.05), sy(cx - 0.15 + sh, cy - 0.05));
      ctx.lineTo(sx(cx + 0.1 + sh, cy - 0.05), sy(cx + 0.1 + sh, cy - 0.05));
      ctx.stroke();
    } else if (v < 0.28) {
      for (let i = 0; i < 4; i++) {
        floorBlob(tx + 0.15 + hash(tx, ty, 10 + i) * 0.7, ty + 0.15 + hash(tx, ty, 20 + i) * 0.7,
          0.08 + hash(tx, ty, 30 + i) * 0.12, i % 2 ? C.moss1 : C.moss0);
      }
      floorBlob(cx, cy, 0.05, C.moss2);
    } else if (v < 0.38) {
      floorBlob(cx, cy, 0.24, C.grime);
      floorBlob(cx + 0.05, cy, 0.12, C.rust0);
    } else if (v < 0.46) {
      ctx.strokeStyle = C.metal0; ctx.lineWidth = px(1);
      for (let i = 1; i < 4; i++) {
        const k = i / 4;
        ctx.beginPath();
        ctx.moveTo(sx(tx + 0.2, ty + k), sy(tx + 0.2, ty + k));
        ctx.lineTo(sx(tx + 0.8, ty + k), sy(tx + 0.8, ty + k));
        ctx.stroke();
      }
    } else if (v < 0.56) {
      ctx.strokeStyle = C.conc0; ctx.lineWidth = px(1);
      ctx.beginPath();
      let x = tx + 0.1, y = ty + 0.2 + hash(tx, ty, 4) * 0.6;
      ctx.moveTo(sx(x, y), sy(x, y));
      for (let i = 0; i < 4; i++) {
        x += 0.2; y += (hash(tx, ty, 40 + i) - 0.5) * 0.3;
        ctx.lineTo(sx(x, y), sy(x, y));
      }
      ctx.stroke();
    }
  }

  // ---- biome tile sets -------------------------------------------------------
  const dot1 = (x, y, color, lift = 0) => { ctx.fillStyle = color; ctx.fillRect(sx(x, y) - onePx / 2, sy(x, y) - lift - onePx / 2, onePx, onePx); };
  const tuft = (x, y, color, h = 5, lift = 0) => {
    const X = sx(x, y), Y = sy(x, y) - lift;
    ctx.strokeStyle = color; ctx.lineWidth = px(1);
    ctx.beginPath(); ctx.moveTo(X - 2, Y); ctx.lineTo(X - 3, Y - h * 0.8); ctx.moveTo(X, Y); ctx.lineTo(X, Y - h); ctx.moveTo(X + 2, Y); ctx.lineTo(X + 3, Y - h * 0.7); ctx.stroke();
  };
  const glowPulse = (t, seed, speed = 1.5) => 0.5 + 0.5 * Math.sin(t * speed + seed * 7);

  // A curl: a spiral stroke, the building block of the ornamental flora.
  function curl(X, Y, r, dir, turns, color, width = 1) {
    ctx.strokeStyle = color; ctx.lineWidth = px(width); ctx.beginPath();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const f = i / n, a = dir * f * turns * Math.PI * 2, rr = r * (1 - f * 0.85);
      const x = X + Math.cos(a) * rr * dir, y = Y + Math.sin(a) * rr;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  // Ornament plant: a stem rising from the floor that rolls into curls,
  // drawn like a spray-painted flourish rather than a real plant.
  function ornament(x, y, seed, lift = 0, scaleK = 1) {
    const X = sx(x, y), Y = sy(x, y) - lift;
    const h = (12 + hash(seed, 1, 3) * 10) * scaleK, lean = (hash(seed, 2, 3) - 0.5) * 10 * scaleK;
    ctx.strokeStyle = C.moss2; ctx.lineWidth = px(1.5);
    ctx.beginPath(); ctx.moveTo(X, Y); ctx.quadraticCurveTo(X - lean, Y - h * 0.6, X + lean * 0.4, Y - h); ctx.stroke();
    curl(X + lean * 0.4 + 3 * scaleK, Y - h, 4 * scaleK, 1, 1.1, C.moss3, 1.5);
    const sides = 1 + Math.floor(hash(seed, 3, 3) * 3);
    for (let i = 0; i < sides; i++) {
      const f = 0.35 + i * 0.2, d = i % 2 ? 1 : -1;
      const bx = X - lean * f * 0.8, by = Y - h * f;
      ctx.strokeStyle = C.moss2; ctx.lineWidth = px(1);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx + d * 4 * scaleK, by - 4 * scaleK, bx + d * 6 * scaleK, by - 2 * scaleK); ctx.stroke();
      curl(bx + d * 7 * scaleK, by - 2 * scaleK, 2.5 * scaleK, d, 0.9, i % 2 ? C.moss3 : C.cell0);
    }
  }

  // Overgrown garden: dark soil, moss, ornamental curl-plants, glowing fungus.
  function floorGarden(tx, ty, t) {
    const n = hash(tx, ty), v = hash(tx, ty, 1);
    diamond(tx, ty, 0);
    ctx.fillStyle = n < 0.5 ? C.grime : C.rust0; ctx.fill();
    for (let i = 0; i < 3; i++) {
      floorBlob(tx + 0.15 + hash(tx, ty, 10 + i) * 0.7, ty + 0.15 + hash(tx, ty, 20 + i) * 0.7,
        0.1 + hash(tx, ty, 30 + i) * 0.16, i % 2 ? C.moss0 : C.moss1);
    }
    for (let i = 0; i < 3; i++) if (hash(tx, ty, 40 + i) < 0.7) tuft(tx + 0.15 + hash(tx, ty, 50 + i) * 0.7, ty + 0.15 + hash(tx, ty, 60 + i) * 0.7, i ? C.moss2 : C.moss3);
    if (v < 0.07) {
      // Mushroom cluster with a soft glow.
      const mx = tx + 0.3 + hash(tx, ty, 70) * 0.4, my = ty + 0.3 + hash(tx, ty, 71) * 0.4;
      for (let i = 0; i < 3; i++) {
        const X = sx(mx + i * 0.08, my - i * 0.05), Y = sy(mx + i * 0.08, my - i * 0.05);
        ctx.fillStyle = C.hull1; ctx.fillRect(X - 0.5, Y - 4 - i, 1.5, 4 + i);
        ctx.fillStyle = C.cell1; ctx.beginPath(); ctx.ellipse(X, Y - 4 - i, 3, 1.6, 0, 0, Math.PI * 2); ctx.fill();
      }
      lights.push({ x: sx(mx, my), y: sy(mx, my) - 5, r: 30 + glowPulse(t, n) * 6, color: C.cell1, glow: 0.22 });
    } else if (v < 0.13) {
      floorBlob(tx + 0.5, ty + 0.5, 0.28, C.void2); // mud
      floorBlob(tx + 0.45, ty + 0.45, 0.12, C.puddle0);
    }
  }
  function gardenOrnaments(tx, ty) {
    if (hash(tx, ty, 77) < 0.09) ornament(tx + 0.3 + hash(tx, ty, 78) * 0.4, ty + 0.3 + hash(tx, ty, 79) * 0.4, tx * 131 + ty);
  }
  function deckGarden(tx, ty) {
    diamond(tx, ty, 0); ctx.fillStyle = C.grime; ctx.fill();
    ctx.strokeStyle = C.rust1; ctx.lineWidth = px(1);
    ctx.beginPath(); // roots
    for (let i = 0; i < 2; i++) {
      const a = tx + hash(tx, ty, 80 + i) * 0.8, b = ty + 0.1;
      ctx.moveTo(sx(a, b), sy(a, b)); ctx.quadraticCurveTo(sx(a + 0.2, b + 0.5), sy(a + 0.2, b + 0.5), sx(a + 0.1, b + 0.85), sy(a + 0.1, b + 0.85));
    }
    ctx.stroke();
    floorBlob(tx + 0.5, ty + 0.5, 0.2, C.moss1);
    tuft(tx + 0.3, ty + 0.8, C.moss3, 4); tuft(tx + 0.8, ty + 0.4, C.moss2, 4);
  }

  // Rust foundry: riveted steel plates, rust blooms, oil, glowing ember cracks.
  function floorFoundry(tx, ty, t) {
    const n = hash(tx, ty), v = hash(tx, ty, 1);
    diamond(tx, ty, 0); ctx.fillStyle = n < 0.5 ? C.metal1 : C.metal0; ctx.fill();
    ctx.strokeStyle = C.void2; ctx.lineWidth = px(1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx(tx + 0.5, ty), sy(tx + 0.5, ty)); ctx.lineTo(sx(tx + 0.5, ty + 1), sy(tx + 0.5, ty + 1)); ctx.stroke();
    for (const [a, b] of [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9], [0.4, 0.5], [0.6, 0.5]]) dot1(tx + a, ty + b, C.metal3);
    if (hash(tx, ty, 2) < 0.4) { floorBlob(tx + 0.3 + hash(tx, ty, 3) * 0.4, ty + 0.3 + hash(tx, ty, 4) * 0.4, 0.18, C.rust0); floorBlob(tx + 0.45, ty + 0.5, 0.08, C.rust1); }
    if (v < 0.1) {
      floorBlob(tx + 0.5, ty + 0.5, 0.3, C.void1); // oil slick with a sheen
      for (let i = 0; i < 4; i++) dot1(tx + 0.35 + hash(tx, ty, 90 + i) * 0.3, ty + 0.35 + hash(tx, ty, 95 + i) * 0.3, [C.elec0, C.hot0, C.cell0, C.moss2][i]);
    } else if (v < 0.17) {
      // Ember crack: glows and flickers.
      const fl = 0.6 + 0.4 * hash(Math.floor(t * 8), tx, ty);
      ctx.strokeStyle = C.hot0; ctx.lineWidth = px(2);
      ctx.beginPath();
      let x = tx + 0.15, y = ty + 0.3 + hash(tx, ty, 5) * 0.4;
      ctx.moveTo(sx(x, y), sy(x, y));
      for (let i = 0; i < 4; i++) { x += 0.18; y += (hash(tx, ty, 6 + i) - 0.5) * 0.3; ctx.lineTo(sx(x, y), sy(x, y)); }
      ctx.stroke();
      ctx.strokeStyle = C.hot1; ctx.lineWidth = px(1); ctx.stroke();
      lights.push({ x: sx(tx + 0.5, ty + 0.5), y: sy(tx + 0.5, ty + 0.5), r: 30 * fl, color: C.hot1, glow: 0.25 * fl });
    }
  }
  function deckFoundry(tx, ty) {
    diamond(tx, ty, 0); ctx.fillStyle = C.void2; ctx.fill();
    ctx.strokeStyle = C.metal2; ctx.lineWidth = px(1);
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      const f = k / 4;
      ctx.moveTo(sx(tx + f, ty), sy(tx + f, ty)); ctx.lineTo(sx(tx + f, ty + 1), sy(tx + f, ty + 1));
      ctx.moveTo(sx(tx, ty + f), sy(tx, ty + f)); ctx.lineTo(sx(tx + 1, ty + f), sy(tx + 1, ty + f));
    }
    ctx.stroke();
    diamond(tx, ty, 0); ctx.strokeStyle = C.metal3; ctx.stroke();
    if (hash(tx, ty, 7) < 0.3) floorBlob(tx + 0.5, ty + 0.5, 0.15, C.rust0);
  }

  // Flooded drains: wet brick and shallow water with spreading ripples.
  function floorDrains(tx, ty, t) {
    const v = hash(tx, ty, 1);
    diamond(tx, ty, 0); ctx.fillStyle = C.rust0; ctx.fill();
    ctx.strokeStyle = C.conc0; ctx.lineWidth = px(1);
    ctx.beginPath(); // brick courses with staggered joints
    for (let r = 0; r < 4; r++) {
      const y = ty + (r + 1) / 4;
      if (r < 3) { ctx.moveTo(sx(tx, y), sy(tx, y)); ctx.lineTo(sx(tx + 1, y), sy(tx + 1, y)); }
      for (let c = (r % 2) * 0.25; c < 1; c += 0.5) {
        const x = tx + c + 0.25;
        ctx.moveTo(sx(x, y - 0.25), sy(x, y - 0.25)); ctx.lineTo(sx(x, y), sy(x, y));
      }
    }
    ctx.stroke();
    if (v < 0.4) {
      // Shallow water over the bricks.
      diamond(tx, ty, 0, 0.04); ctx.fillStyle = C.puddle0; ctx.fill();
      const ph = (t * 0.6 + hash(tx, ty, 3) * 3) % 1;
      const rx = tx + 0.3 + hash(tx, ty, 4) * 0.4, ry = ty + 0.3 + hash(tx, ty, 5) * 0.4;
      ctx.strokeStyle = C.puddle1; ctx.lineWidth = px(1);
      ctx.globalAlpha = 1 - ph;
      ctx.beginPath(); ctx.ellipse(sx(rx, ry), sy(rx, ry), 3 + ph * 14, (3 + ph * 14) * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      const sh = Math.sin(t * 1.1 + tx) * 0.08;
      ctx.beginPath(); ctx.moveTo(sx(tx + 0.2 + sh, ty + 0.3), sy(tx + 0.2 + sh, ty + 0.3)); ctx.lineTo(sx(tx + 0.45 + sh, ty + 0.3), sy(tx + 0.45 + sh, ty + 0.3)); ctx.stroke();
    } else if (v < 0.5) {
      floorBlob(tx + 0.5, ty + 0.5, 0.2, C.moss0);
    } else if (v < 0.56) {
      diamond(tx, ty, 0, 0.25); ctx.fillStyle = C.void0; ctx.fill(); // drain grate
      ctx.strokeStyle = C.metal2; ctx.beginPath();
      for (let k = 1; k < 4; k++) { const f = 0.25 + k * 0.125; ctx.moveTo(sx(tx + f, ty + 0.25), sy(tx + f, ty + 0.25)); ctx.lineTo(sx(tx + f, ty + 0.75), sy(tx + f, ty + 0.75)); }
      ctx.stroke();
    }
  }
  function deckDrains(tx, ty) {
    diamond(tx, ty, 0); ctx.fillStyle = C.conc2; ctx.fill();
    ctx.strokeStyle = C.conc0; ctx.lineWidth = px(1); ctx.stroke();
    ctx.strokeStyle = C.moss1;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) { const a = tx + 0.2 + i * 0.3; ctx.moveTo(sx(a, ty + 0.1), sy(a, ty + 0.1)); ctx.lineTo(sx(a + 0.05, ty + 0.9), sy(a + 0.05, ty + 0.9)); }
    ctx.stroke();
    ctx.strokeStyle = C.puddle1;
    ctx.beginPath(); ctx.moveTo(sx(tx + 0.2, ty + 0.6), sy(tx + 0.2, ty + 0.6)); ctx.lineTo(sx(tx + 0.5, ty + 0.6), sy(tx + 0.5, ty + 0.6)); ctx.stroke();
  }

  // The hive: dark membrane over ribs of bone, red veins, pulsing pustules.
  function floorHive(tx, ty, t) {
    const v = hash(tx, ty, 1);
    // Dark flesh (kept dull so red stainers and blood still read on it).
    diamond(tx, ty, 0); ctx.fillStyle = C.void1; ctx.fill();
    ctx.globalAlpha = 0.55; ctx.fillStyle = C.blood0; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = px(2); ctx.strokeStyle = C.hull0;
    ctx.beginPath(); // a bone rib arcing across the tile
    const a = hash(tx, ty, 2) * 0.6 + 0.2;
    ctx.moveTo(sx(tx, ty + a), sy(tx, ty + a)); ctx.quadraticCurveTo(sx(tx + 0.5, ty + a - 0.25), sy(tx + 0.5, ty + a - 0.25), sx(tx + 1, ty + a), sy(tx + 1, ty + a)); ctx.stroke();
    ctx.lineWidth = px(1); ctx.strokeStyle = C.hull1;
    ctx.beginPath(); ctx.moveTo(sx(tx + 0.1, ty + a - 0.04), sy(tx + 0.1, ty + a - 0.04)); ctx.quadraticCurveTo(sx(tx + 0.5, ty + a - 0.3), sy(tx + 0.5, ty + a - 0.3), sx(tx + 0.9, ty + a - 0.04), sy(tx + 0.9, ty + a - 0.04)); ctx.stroke();
    ctx.strokeStyle = v < 0.5 ? C.blood0 : C.blood1; // veins
    ctx.beginPath();
    let x = tx + 0.1, y = ty + 0.2 + hash(tx, ty, 3) * 0.6;
    ctx.moveTo(sx(x, y), sy(x, y));
    for (let i = 0; i < 4; i++) { x += 0.2; y += (hash(tx, ty, 4 + i) - 0.5) * 0.3; ctx.lineTo(sx(x, y), sy(x, y)); }
    ctx.stroke();
    if (v < 0.08) {
      const px0 = tx + 0.3 + hash(tx, ty, 9) * 0.4, py0 = ty + 0.3 + hash(tx, ty, 10) * 0.4, pul = glowPulse(t, v, 2.4);
      floorBlob(px0, py0, 0.06 + pul * 0.02, C.blood1);
      dot1(px0 - 0.02, py0 - 0.02, C.blood2);
      lights.push({ x: sx(px0, py0), y: sy(px0, py0), r: 14 + pul * 8, color: C.blood1, glow: 0.1 + pul * 0.1 });
    } else if (v < 0.24) {
      for (let i = 0; i < 4; i++) dot1(tx + 0.2 + hash(tx, ty, 20 + i) * 0.6, ty + 0.2 + hash(tx, ty, 30 + i) * 0.6, C.void0); // pores
    }
  }
  function deckHive(tx, ty) {
    diamond(tx, ty, 0); ctx.fillStyle = C.hull0; ctx.fill();
    ctx.strokeStyle = C.hull1; ctx.lineWidth = px(1);
    ctx.beginPath();
    for (let k = 1; k < 4; k++) { const f = k / 4; ctx.moveTo(sx(tx + 0.05, ty + f), sy(tx + 0.05, ty + f)); ctx.quadraticCurveTo(sx(tx + 0.5, ty + f - 0.12), sy(tx + 0.5, ty + f - 0.12), sx(tx + 0.95, ty + f), sy(tx + 0.95, ty + f)); }
    ctx.stroke();
    ctx.strokeStyle = C.metal1; diamond(tx, ty, 0); ctx.stroke();
    if (hash(tx, ty, 8) < 0.3) dot1(tx + 0.5, ty + 0.5, C.blood2);
  }

  const BIOME_FLOOR = [null, floorGarden, floorFoundry, floorDrains, floorHive];
  const BIOME_DECK = [null, deckGarden, deckFoundry, deckDrains, deckHive];

  // Walls per biome: [face +y, face +x, top, top inner line] plus decoration.
  const WALL_COLORS = [
    [C.metal1, C.metal0, C.metal3, C.metal2], // yard: machinery
    [C.conc1, C.conc0, C.moss1, C.moss2], // garden: overgrown stone
    [C.metal0, C.void2, C.metal2, C.metal1], // foundry: furnace blocks
    [C.rust1, C.rust0, C.conc2, C.conc1], // drains: brick pillars
    [C.hull1, C.hull0, C.bone, C.hull1], // hive: bone columns
  ];
  function decorateWallBiome(b, face, t) {
    const { tx, ty } = face, k = face.side === 'y' ? 300 : 350;
    if (b === 1) {
      // Vines and moss hanging from the top.
      for (let i = 0; i < 4; i++) {
        const u = 0.1 + hash(tx, ty, k + i) * 0.8, len = 0.3 + hash(tx, ty, k + 10 + i) * 0.6;
        ctx.strokeStyle = i % 2 ? C.moss2 : C.moss1; ctx.lineWidth = px(1);
        ctx.beginPath(); ctx.moveTo(...facePoint(face, u, 1)); ctx.quadraticCurveTo(...facePoint(face, u + 0.05, 1 - len / 2), ...facePoint(face, u - 0.02, 1 - len)); ctx.stroke();
        const [lx, ly] = facePoint(face, u - 0.02, 1 - len);
        ctx.fillStyle = C.moss3; ctx.fillRect(lx - 1, ly - 1, 2, 2);
      }
      faceQuad(face, 0, 1, 0.8, 1); ctx.fillStyle = C.moss1; ctx.fill();
    } else if (b === 2) {
      // Glowing furnace slits, rivet rows.
      const fl = 0.6 + 0.4 * hash(Math.floor(t * 6), tx + ty, k);
      faceQuad(face, 0.2, 0.8, 0.45, 0.55); ctx.fillStyle = C.void0; ctx.fill();
      faceQuad(face, 0.25, 0.75, 0.47, 0.53); ctx.fillStyle = fl > 0.8 ? C.hot1 : C.hot0; ctx.fill();
      const [lx, ly] = facePoint(face, 0.5, 0.5);
      lights.push({ x: lx, y: ly + 6, r: 40 * fl, color: C.hot1, glow: 0.25 * fl });
      for (let i = 0; i < 6; i++) { const [rx, ry] = facePoint(face, 0.1 + i * 0.16, 0.85); ctx.fillStyle = C.metal3; ctx.fillRect(rx - onePx / 2, ry - onePx / 2, onePx, onePx); }
    } else if (b === 3) {
      // Brick courses, a water stain and a dripping spout.
      ctx.strokeStyle = C.conc0; ctx.lineWidth = px(1);
      for (let r = 1; r < 5; r++) {
        const v = r / 5;
        ctx.beginPath(); ctx.moveTo(...facePoint(face, 0, v)); ctx.lineTo(...facePoint(face, 1, v)); ctx.stroke();
        for (let c = (r % 2) * 0.17; c < 1; c += 0.34) { ctx.beginPath(); ctx.moveTo(...facePoint(face, c + 0.17, v)); ctx.lineTo(...facePoint(face, c + 0.17, v - 0.2)); ctx.stroke(); }
      }
      faceQuad(face, 0.55, 0.65, 0.7, 0); ctx.fillStyle = C.puddle0; ctx.fill();
      if (hash(tx, ty, k + 3) < 0.5) {
        faceQuad(face, 0.52, 0.68, 0.62, 0.72); ctx.fillStyle = C.metal2; ctx.fill();
        const drip = (t * 1.3 + hash(tx, ty, k)) % 1;
        const [dx, dy] = facePoint(face, 0.6, 0.62 - drip * 0.6);
        ctx.fillStyle = C.puddle1; ctx.fillRect(dx - 0.5, dy, 1.5, 2);
        const [lx, ly] = facePoint(face, 0.6, 0.85);
        if (hash(tx, ty, k + 4) < 0.5) lights.push({ x: lx, y: ly + 8, r: 70, color: C.elec1, glow: 0.12 });
      }
    } else if (b === 4) {
      // Vertebral ridges and veins.
      for (let r = 1; r < 6; r++) {
        const v = r / 6;
        faceQuad(face, 0, 1, v - 0.03, v); ctx.fillStyle = C.metal1; ctx.fill();
        faceQuad(face, 0, 1, v, v + 0.03); ctx.fillStyle = C.bone; ctx.fill();
      }
      ctx.strokeStyle = C.blood1; ctx.lineWidth = px(1);
      ctx.beginPath(); ctx.moveTo(...facePoint(face, 0.3, 1)); ctx.quadraticCurveTo(...facePoint(face, 0.5, 0.5), ...facePoint(face, 0.35, 0)); ctx.stroke();
      if (hash(tx, ty, k + 5) < 0.4) {
        const pul = glowPulse(t, hash(tx, ty, k), 2);
        const [lx, ly] = facePoint(face, 0.6, 0.4);
        ctx.fillStyle = C.blood2; ctx.beginPath(); ctx.arc(lx, ly, px(2 + pul), 0, Math.PI * 2); ctx.fill();
        lights.push({ x: lx, y: ly, r: 22 + pul * 10, color: C.blood2, glow: 0.25 });
      }
    }
  }
  function decorateWallTop(b, tx, ty, lift) {
    if (b === 1) { for (let i = 0; i < 3; i++) tuft(tx + 0.2 + hash(tx, ty, 120 + i) * 0.6, ty + 0.2 + hash(tx, ty, 130 + i) * 0.6, C.moss3, 5, lift); if (hash(tx, ty, 140) < 0.3) dot1(tx + 0.5, ty + 0.5, C.lamp1, lift); }
    else if (b === 2) { ctx.fillStyle = C.void0; ctx.beginPath(); ctx.ellipse(sx(tx + 0.5, ty + 0.5), sy(tx + 0.5, ty + 0.5) - lift, 6, 3, 0, 0, Math.PI * 2); ctx.fill(); dot1(tx + 0.5, ty + 0.5, C.hot0, lift); }
    else if (b === 3) { ctx.fillStyle = C.moss1; ctx.beginPath(); ctx.ellipse(sx(tx + 0.4, ty + 0.6), sy(tx + 0.4, ty + 0.6) - lift, 7, 3, 0, 0, Math.PI * 2); ctx.fill(); }
    else if (b === 4) { for (let i = 0; i < 5; i++) dot1(tx + 0.2 + hash(tx, ty, 150 + i) * 0.6, ty + 0.2 + hash(tx, ty, 160 + i) * 0.6, C.hull0, lift); }
  }

  // Cliff faces per biome: [face +y, face +x, strata, foot].
  const CLIFF_COLORS = [
    [C.conc0, C.void2, C.conc0, C.grime],
    [C.rust0, C.grime, C.void2, C.moss0],
    [C.metal1, C.metal0, C.void2, C.rust0],
    [C.rust0, C.conc0, C.conc0, C.puddle0],
    [C.hull0, C.blood0, C.metal1, C.blood0],
  ];

  // ---- terrain columns -------------------------------------------------------
  // Earth/concrete cliff faces under raised floors and slopes.
  function decorateCliff(face, cc = [C.conc0, C.void2, C.conc0, C.grime]) {
    const { tx, ty } = face, k = face.side === 'y' ? 200 : 250;
    // Strata line and grime at the foot.
    ctx.strokeStyle = cc[2]; ctx.lineWidth = px(1);
    ctx.beginPath(); ctx.moveTo(...facePoint(face, 0, 0.5)); ctx.lineTo(...facePoint(face, 1, 0.5)); ctx.stroke();
    faceQuad(face, 0, 1, 0, 0.18); ctx.fillStyle = cc[3]; ctx.fill();
    if (hash(tx, ty, k + 1) < 0.5) {
      const u = 0.1 + hash(tx, ty, k + 2) * 0.7;
      faceQuad(face, u, u + 0.1, 1, 0.3); ctx.fillStyle = C.rust0; ctx.fill();
    }
    if (hash(tx, ty, k + 3) < 0.3) {
      // Drain outlet weeping rust.
      const u = 0.25 + hash(tx, ty, k + 4) * 0.5;
      faceQuad(face, u, u + 0.14, 0.45, 0.8); ctx.fillStyle = C.metal2; ctx.fill();
      faceQuad(face, u + 0.03, u + 0.11, 0.5, 0.75); ctx.fillStyle = C.void0; ctx.fill();
      faceQuad(face, u + 0.05, u + 0.09, 0.05, 0.5); ctx.fillStyle = C.rust1; ctx.fill();
    }
    // Moss over the lip.
    ctx.fillStyle = C.moss1;
    for (let i = 0; i < 4; i++) {
      if (hash(tx, ty, k + 10 + i) < 0.5) continue;
      const u = hash(tx, ty, k + 20 + i) * 0.9;
      faceQuad(face, u, u + 0.08, 1, 0.75 - hash(tx, ty, k + 30 + i) * 0.3); ctx.fill();
    }
  }

  // Point on a slope tile: f along the rise (0 low .. 1 high), g across it.
  function slopeXY(tx, ty, dx, dy, f, g) {
    if (dx > 0) return [tx + f, ty + g];
    if (dx < 0) return [tx + 1 - f, ty + g];
    if (dy > 0) return [tx + g, ty + f];
    return [tx + g, ty + 1 - f];
  }
  function slopeQuad(tx, ty, dx, dy, f0, f1, h0, h1) {
    const pts = [[f0, 0, h0], [f1, 0, h1], [f1, 1, h1], [f0, 1, h0]];
    ctx.beginPath();
    pts.forEach(([f, g, hh], i) => {
      const [x, y] = slopeXY(tx, ty, dx, dy, f, g);
      if (i) ctx.lineTo(sx(x, y), sy(x, y) - hh); else ctx.moveTo(sx(x, y), sy(x, y) - hh);
    });
    ctx.closePath();
  }

  function drawRamp(tx, ty, dx, dy, base) {
    slopeQuad(tx, ty, dx, dy, 0, 1, base, base + LEVEL_PX);
    ctx.fillStyle = C.conc2; ctx.fill();
    // Grip grooves across the slope.
    ctx.strokeStyle = C.conc1; ctx.lineWidth = px(1);
    for (let i = 1; i < 6; i++) {
      const f = i / 6;
      const [ax, ay] = slopeXY(tx, ty, dx, dy, f, 0.06), [bx, by] = slopeXY(tx, ty, dx, dy, f, 0.94);
      const hh = base + f * LEVEL_PX;
      ctx.beginPath(); ctx.moveTo(sx(ax, ay), sy(ax, ay) - hh); ctx.lineTo(sx(bx, by), sy(bx, by) - hh); ctx.stroke();
    }
    // Worn hazard paint at the foot.
    ctx.save();
    slopeQuad(tx, ty, dx, dy, 0.02, 0.1, base + 0.02 * LEVEL_PX, base + 0.1 * LEVEL_PX);
    ctx.clip();
    for (let i = 0; i < 6; i++) {
      const [x, y] = slopeXY(tx, ty, dx, dy, 0.06, i / 6 + 0.04);
      ctx.fillStyle = i % 2 ? C.void1 : C.lamp0;
      ctx.fillRect(sx(x, y) - 3, sy(x, y) - base - 4, 6, 8);
    }
    ctx.restore();
  }

  function drawStairs(tx, ty, dx, dy, base) {
    const N = 4;
    // Risers face the low side; they are visible when that side faces the camera.
    const risersVisible = dx < 0 || dy < 0;
    const order = [...Array(N).keys()];
    if (risersVisible) order.reverse(); // draw back to front
    for (const k of order) {
      const f0 = k / N, f1 = (k + 1) / N, h = base + f1 * LEVEL_PX;
      slopeQuad(tx, ty, dx, dy, f0, f1, h, h);
      ctx.fillStyle = k % 2 ? C.conc3 : C.conc2; ctx.fill();
      // Worn nosing on the tread edge.
      const [ax, ay] = slopeXY(tx, ty, dx, dy, f0, 0), [bx, by] = slopeXY(tx, ty, dx, dy, f0, 1);
      ctx.strokeStyle = C.metal3; ctx.lineWidth = px(1);
      ctx.beginPath(); ctx.moveTo(sx(ax, ay), sy(ax, ay) - h); ctx.lineTo(sx(bx, by), sy(bx, by) - h); ctx.stroke();
      if (risersVisible) {
        const hl = base + f0 * LEVEL_PX;
        ctx.beginPath();
        ctx.moveTo(sx(ax, ay), sy(ax, ay) - hl); ctx.lineTo(sx(bx, by), sy(bx, by) - hl);
        ctx.lineTo(sx(bx, by), sy(bx, by) - h); ctx.lineTo(sx(ax, ay), sy(ax, ay) - h);
        ctx.closePath(); ctx.fillStyle = C.conc0; ctx.fill();
      }
    }
  }

  // A raised floor, ramp or stairs tile, with its cliff faces.
  function drawColumn(tx, ty, t, alpha = 1) {
    ctx.globalAlpha = alpha;
    const i = ty * map.w + tx;
    for (const f of columnFaces(tx, ty, (gx, gy) => cornerPx(tx, ty, gx, gy))) {
      const cc = CLIFF_COLORS[biomeAt(tx, ty)];
      faceQuad(f, 0, 1, 0, 1);
      ctx.fillStyle = f.side === 'y' ? cc[0] : cc[1]; ctx.fill();
      decorateCliff(f, cc);
    }
    const base = map.level[i] * LEVEL_PX;
    if (map.kind[i]) {
      if (map.kind[i] === 1) drawRamp(tx, ty, map.sdx[i], map.sdy[i], base);
      else drawStairs(tx, ty, map.sdx[i], map.sdy[i], base);
      const lv = map.level[i] + 0.5;
      shadowsOn(tx, ty, lv, () => slopeQuad(tx, ty, map.sdx[i], map.sdy[i], 0, 1, base, base + LEVEL_PX));
    } else {
      ctx.save(); ctx.translate(0, -base);
      drawDeck(tx, ty, map.level[i]);
      // Worn bright lip along the front edges, so the drop reads.
      ctx.strokeStyle = C.metal4; ctx.lineWidth = px(2);
      ctx.beginPath();
      ctx.moveTo(sx(tx, ty + 1), sy(tx, ty + 1)); ctx.lineTo(sx(tx + 1, ty + 1), sy(tx + 1, ty + 1)); ctx.lineTo(sx(tx + 1, ty), sy(tx + 1, ty));
      ctx.stroke();
      ctx.restore();
      drawTileBlood(tx, ty, base, true);
      shadowsOn(tx, ty, map.level[i], () => diamond(tx, ty, base));
    }
    ctx.globalAlpha = 1;
  }

  // ---- walls ---------------------------------------------------------------
  function decorateFace(face, t) {
    const { tx, ty } = face, k = face.side === 'y' ? 0 : 50;
    ctx.strokeStyle = C.metal0; ctx.lineWidth = px(1);
    ctx.beginPath(); ctx.moveTo(...facePoint(face, 0.5, 0)); ctx.lineTo(...facePoint(face, 0.5, 1)); ctx.stroke();
    if (hash(tx, ty, k + 1) < 0.45) {
      // Rust bleeding down from the top.
      const u = 0.1 + hash(tx, ty, k + 2) * 0.6, len = 0.35 + hash(tx, ty, k + 3) * 0.5;
      faceQuad(face, u, u + 0.14, 1, 1 - len);
      ctx.fillStyle = C.rust0; ctx.fill();
      faceQuad(face, u + 0.03, u + 0.08, 1, 1 - len * 0.7);
      ctx.fillStyle = C.rust1; ctx.fill();
    }
    if (hash(tx, ty, k + 4) < 0.3) {
      // A pipe running along the face.
      const v = 0.25 + hash(tx, ty, k + 5) * 0.3;
      ctx.lineWidth = px(3); ctx.strokeStyle = C.metal2;
      ctx.beginPath(); ctx.moveTo(...facePoint(face, 0, v)); ctx.lineTo(...facePoint(face, 1, v)); ctx.stroke();
      ctx.lineWidth = px(1); ctx.strokeStyle = C.metal4;
      ctx.beginPath(); ctx.moveTo(...facePoint(face, 0, v + 0.04)); ctx.lineTo(...facePoint(face, 1, v + 0.04)); ctx.stroke();
    }
    if (hash(tx, ty, k + 6) < 0.25) {
      // Sagging cable.
      const a = facePoint(face, 0.08, 0.9), b = facePoint(face, 0.92, 0.82), m = facePoint(face, 0.5, 0.45);
      ctx.strokeStyle = C.limb; ctx.lineWidth = px(1.5);
      ctx.beginPath(); ctx.moveTo(...a); ctx.quadraticCurveTo(...m, ...b); ctx.stroke();
    }
    if (hash(tx, ty, k + 7) < 0.13) {
      // Caged lamp. Some of them flicker.
      const flickers = hash(tx, ty, k + 8) < 0.4;
      const on = !flickers || hash(Math.floor(t * 9), tx + ty, k) > 0.25;
      faceQuad(face, 0.42, 0.58, 0.62, 0.8);
      ctx.fillStyle = C.metal0; ctx.fill();
      faceQuad(face, 0.45, 0.55, 0.65, 0.77);
      ctx.fillStyle = on ? C.lamp1 : C.lamp0; ctx.fill();
      if (on) {
        const [lx, ly] = facePoint(face, 0.5, 0.7);
        lights.push({ x: lx, y: ly + 10, r: 95, color: C.lamp1, glow: 0.22 });
      }
    }
    if (hash(tx, ty, k + 9) < 0.3) {
      // Moss dripping over the top edge.
      ctx.fillStyle = C.moss1;
      for (let i = 0; i < 3; i++) {
        const u = hash(tx, ty, k + 10 + i) * 0.9;
        faceQuad(face, u, u + 0.06, 1, 1 - 0.1 - hash(tx, ty, k + 20 + i) * 0.25);
        ctx.fill();
      }
    }
  }

  // Made-up script: each glyph is a few strokes on a 3 x 4 grid.
  const GLYPH_STROKES = [[0, 0, 2, 0], [0, 0, 0, 3], [2, 0, 2, 3], [0, 3, 2, 3], [0, 1, 2, 1], [1, 0, 1, 3], [0, 0, 2, 3], [2, 0, 0, 2], [0, 2, 2, 2], [1, 1, 2, 3]];
  const NEON = () => [C.neon1, C.elec1, C.lamp1];
  function neonSign(face, tx, ty, t) {
    const k = face.side === 'y' ? 0 : 50;
    const color = NEON()[Math.floor(hash(tx, ty, 402 + k) * 3)];
    const n = 2 + Math.floor(hash(tx, ty, 403 + k) * 3);
    const u0 = 0.12, u1 = 0.88, v0 = 0.42, v1 = 0.82;
    faceQuad(face, u0, u1, v0, v1);
    ctx.fillStyle = C.void0; ctx.fill();
    const broken = hash(tx, ty, 404 + k) < 0.35; // some tubes buzz on and off
    const cw = (u1 - u0 - 0.08) / n;
    ctx.strokeStyle = color; ctx.lineWidth = px(1.2); ctx.lineCap = 'round';
    let lit = 0;
    for (let g = 0; g < n; g++) {
      if (broken && hash(Math.floor(t * 7), tx + g, ty) < 0.3) continue;
      lit++;
      ctx.beginPath();
      const strokes = 2 + Math.floor(hash(tx + g, ty, 405 + k) * 3);
      for (let i = 0; i < strokes; i++) {
        const [a, b, c, d] = GLYPH_STROKES[Math.floor(hash(tx * 7 + g, ty * 3 + i, 406 + k) * GLYPH_STROKES.length)];
        const U = (q) => u0 + 0.04 + g * cw + (q / 2) * cw * 0.7, V = (q) => v1 - 0.06 - (q / 3) * (v1 - v0 - 0.12);
        ctx.moveTo(...facePoint(face, U(a), V(b))); ctx.lineTo(...facePoint(face, U(c), V(d)));
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    if (lit) {
      const [lx, ly] = facePoint(face, 0.5, (v0 + v1) / 2);
      lights.push({ x: lx, y: ly + 6, r: 50 + lit * 8, color, glow: 0.22 });
    }
  }
  // Spray-paint: a looping tag with drips.
  function graffiti(face, tx, ty) {
    const k = face.side === 'y' ? 0 : 50;
    const colors = [C.hull1, C.elec0, C.neon0, C.moss3, C.lamp0];
    const color = colors[Math.floor(hash(tx, ty, 420 + k) * colors.length)];
    ctx.strokeStyle = color; ctx.lineWidth = px(1.5); ctx.globalAlpha *= 0.8;
    ctx.beginPath();
    let u = 0.15 + hash(tx, ty, 421 + k) * 0.1, v = 0.3 + hash(tx, ty, 422 + k) * 0.25;
    ctx.moveTo(...facePoint(face, u, v));
    for (let i = 0; i < 4; i++) {
      const nu = u + 0.15 + hash(tx, ty, 423 + i + k) * 0.08, nv = 0.25 + hash(tx, ty, 430 + i + k) * 0.35;
      ctx.quadraticCurveTo(...facePoint(face, (u + nu) / 2, nv + 0.25), ...facePoint(face, nu, nv));
      u = nu;
    }
    ctx.stroke();
    ctx.lineWidth = px(1);
    for (let i = 0; i < 3; i++) {
      const du = 0.2 + hash(tx, ty, 440 + i + k) * 0.6, dv = 0.3 + hash(tx, ty, 441 + i + k) * 0.2;
      ctx.beginPath(); ctx.moveTo(...facePoint(face, du, dv)); ctx.lineTo(...facePoint(face, du, dv - 0.12 - hash(tx, ty, 442 + i) * 0.15)); ctx.stroke();
    }
    ctx.globalAlpha /= 0.8;
  }

  function wallTop(tx, ty) { return map.level[ty * map.w + tx] * LEVEL_PX + WALL_H; }

  function drawWall(tx, ty, t, alpha = 1) {
    ctx.globalAlpha = alpha;
    const top = wallTop(tx, ty);
    const b = biomeAt(tx, ty), wc = WALL_COLORS[b];
    for (const f of columnFaces(tx, ty, () => top)) {
      faceQuad(f, 0, 1, 0, 1);
      ctx.fillStyle = f.side === 'y' ? wc[0] : wc[1]; ctx.fill();
      if (b) decorateWallBiome(b, f, t); else decorateFace(f, t);
      const k = f.side === 'y' ? 0 : 50;
      const signs = [0.07, 0.02, 0.07, 0.08, 0.02][b], tags = [0.1, 0.04, 0.06, 0.12, 0][b];
      if (hash(tx, ty, 400 + k) < signs) neonSign(f, tx, ty, t);
      else if (hash(tx, ty, 410 + k) < tags) graffiti(f, tx, ty);
    }
    const WALL_H = top; // lift of the top face (shadows the module constant)
    diamond(tx, ty, WALL_H);
    ctx.fillStyle = wc[2]; ctx.fill();
    diamond(tx, ty, WALL_H, 0.12);
    ctx.strokeStyle = wc[3]; ctx.lineWidth = px(1); ctx.stroke();
    if (b) { decorateWallTop(b, tx, ty, WALL_H); ctx.globalAlpha = 1; return; }
    ctx.fillStyle = C.metal4;
    for (const [a, b] of [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]]) {
      ctx.fillRect(sx(tx + a, ty + b) - onePx / 2, sy(tx + a, ty + b) - WALL_H - onePx / 2, onePx, onePx);
    }
    if (hash(tx, ty, 99) < 0.3) {
      for (let i = 0; i < 3; i++) {
        const a = tx + 0.2 + hash(tx, ty, 100 + i) * 0.6, b = ty + 0.2 + hash(tx, ty, 110 + i) * 0.6;
        ctx.fillStyle = i ? C.moss2 : C.moss3;
        ctx.beginPath(); ctx.ellipse(sx(a, b), sy(a, b) - WALL_H, 5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // True when a column (top at `topPx`) drawn after the player covers its sprite.
  function hidesPlayer(tx, ty, pr, topPx) {
    const cx = sx(pr.pos.x, pr.pos.y), cy = sy(pr.pos.x, pr.pos.y) - liftAt(pr.pos.x, pr.pos.y) - 10;
    const left = (tx - ty - 1) * HW, right = (tx - ty + 1) * HW;
    const top = sy(tx, ty) - topPx, bottom = sy(tx + 1, ty + 1);
    const R = 26;
    return cx + R > left && cx - R < right && cy + R > top && cy - R < bottom;
  }

  // ---- batteries -----------------------------------------------------------
  // Big red battery: worth three small cells, and looks it.
  function drawBigCell(s, t) {
    const X = sx(s.x, s.y), Y = sy(s.x, s.y) - liftAt(s.x, s.y);
    const seed = s.x * 3.1 + s.y * 7.7;
    const top = Y - 24;
    ctx.fillStyle = C.blood1; ctx.fillRect(X - 7, top, 14, 24);
    ctx.fillStyle = C.blood2; ctx.fillRect(X - 7, top, 4, 24);
    ctx.fillStyle = C.blood0; ctx.fillRect(X + 4, top, 3, 24);
    ctx.fillStyle = C.void1; ctx.fillRect(X - 7, top + 9, 14, 6);
    ctx.fillStyle = C.metal4;
    ctx.beginPath(); ctx.ellipse(X, top, 7, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(X - 4, top - 4, 3, 4); ctx.fillRect(X + 1, top - 4, 3, 4);
    // Three charge pips, lighting up in turn.
    const step = Math.floor((t * 2 + seed) % 4);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i < step ? C.hot1 : C.blood0;
      ctx.fillRect(X - 5 + i * 4, top + 11, 2, 2);
    }
    const pulse = 0.5 + 0.5 * Math.sin(t * 3 + seed);
    lights.push({ x: X, y: Y - 12, r: 55 + pulse * 10, color: C.hot1, glow: 0.3 + pulse * 0.15 });
  }

  function drawCell(s, t) {
    if (s.big) { drawBigCell(s, t); return; }
    const X = sx(s.x, s.y), Y = sy(s.x, s.y) - liftAt(s.x, s.y);
    const seed = s.x * 3.1 + s.y * 7.7;
    const top = Y - 15;
    ctx.fillStyle = C.cell0; ctx.fillRect(X - 4, top, 8, 15);
    ctx.fillStyle = C.cell1; ctx.fillRect(X - 4, top, 3, 15);
    ctx.fillStyle = C.void2; ctx.fillRect(X - 4, top + 6, 8, 4);
    ctx.fillStyle = C.metal4;
    ctx.beginPath(); ctx.ellipse(X, top, 4, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(X - 1.5, top - 3, 3, 3);
    // Charge light blinks once a second.
    const blink = (t + seed) % 1 < 0.15;
    ctx.fillStyle = blink ? C.elec2 : C.elec0;
    ctx.fillRect(X - 1, top + 7, 2, 2);
    lights.push({ x: X, y: Y - 8, r: 40 + (blink ? 6 : 0), color: C.cell1, glow: 0.3 });
    // Now and then it arcs.
    const ph = (t * 0.45 + seed) % 1;
    if (ph < 0.06) {
      ctx.strokeStyle = ph < 0.03 ? C.elec2 : C.elec1; ctx.lineWidth = px(1);
      ctx.beginPath();
      let ax = X, ay = top - 3;
      ctx.moveTo(ax, ay);
      for (let i = 0; i < 4; i++) {
        ax += (hash(i, Math.floor(t * 30), seed) - 0.5) * 8; ay -= 3;
        ctx.lineTo(ax, ay);
      }
      ctx.stroke();
      lights.push({ x: X, y: top - 6, r: 30, color: C.elec1, glow: 0.4 });
    }
  }

  // ---- bugs ----------------------------------------------------------------
  // style: { shell, shade, limb, legW, led (heat 0..1) | null, overheated }
  function ellipsePath(cx, cy, z, heading, a, b) {
    const c = Math.cos(heading), s = Math.sin(heading);
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const t = (i / 20) * Math.PI * 2;
      const ex = Math.cos(t) * a, ey = Math.sin(t) * b;
      const [qx, qy] = P3(cx + ex * c - ey * s, cy + ex * s + ey * c, z);
      if (i) ctx.lineTo(qx, qy); else ctx.moveTo(qx, qy);
    }
    ctx.closePath();
  }

  function drawLeg(rig, leg, style) {
    const o = rig.opts;
    const hip = hipOf(rig, leg);
    // Feet stand on whatever ground is under them (steps, ramps); in the air they hang free.
    const zl = rig.zLevel ?? lvAt(rig.pos.x, rig.pos.y);
    const footGround = rig.air ? 0 : (lvAt(leg.foot.x, leg.foot.y) - zl) * LEVEL_Z;
    const foot = { x: leg.foot.x, y: leg.foot.y, z: leg.lift + footGround };
    const knee = legIK(hip, foot, o.thigh * o.scale, o.shin * o.scale);
    ctx.strokeStyle = style.limb; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = px(style.legW);
    ctx.beginPath();
    ctx.moveTo(...P3(hip.x, hip.y, hip.z));
    ctx.lineTo(...P3(knee.x, knee.y, knee.z));
    ctx.lineTo(...P3(foot.x, foot.y, foot.z));
    ctx.stroke();
    if (style.led != null) {
      ctx.fillStyle = style.shade;
      const [kx, ky] = P3(knee.x, knee.y, knee.z);
      ctx.beginPath(); ctx.arc(kx, ky, px(style.legW * 0.8), 0, Math.PI * 2); ctx.fill();
    }
  }

  // Ground shadow under a creature that may be in the air: stays on the floor,
  // shrinks and fades with height.
  // Shadows are part of the floor: in the game they are collected first and
  // drawn by the floor tile they fall on (see shadowsOn), so nothing drawn in
  // front of that tile can cut through them. Menu previews draw them directly.
  let previewMode = false;
  const SHADOW = 'rgba(4,6,8,0.62)';
  function groundShadow(rig, a, b) {
    if (!previewMode) return;
    ellipsePath(rig.pos.x, rig.pos.y, 0, rig.heading, a, b);
    ctx.fillStyle = C.void1; ctx.fill();
  }
  let shadows = [];
  // A creature's shadow: an ellipse along its heading, shrinking with height.
  function rigShadow(rig, a, b) {
    const gz = lvAt(rig.pos.x, rig.pos.y), zl = rig.zLevel ?? gz;
    const f = 1 / (1 + Math.max(0, zl - gz) * 1.5);
    shadows.push({ x: rig.pos.x, y: rig.pos.y, gz, draw: () => {
      ellipsePath(rig.pos.x, rig.pos.y, 0, rig.heading, a * f, b * f); ctx.fill();
    } });
  }
  // A round shadow, sized in world pixels.
  function discShadow(x, y, rx, ry, f = 1) {
    const gz = lvAt(x, y);
    shadows.push({ x, y, gz, draw: () => {
      ctx.beginPath(); ctx.ellipse(sx(x, y), sy(x, y) - gz * LEVEL_PX, rx * f, ry * f, 0, 0, Math.PI * 2); ctx.fill();
    } });
  }
  // Draw the shadows that fall on tile (tx, ty) at surface height `level`.
  function shadowsOn(tx, ty, level, clipPath) {
    let open = false;
    for (const sh of shadows) {
      if (Math.abs(Math.floor(sh.x) - tx) > 1 || Math.abs(Math.floor(sh.y) - ty) > 1) continue;
      if (Math.abs(sh.gz - level) > (level % 1 ? 0.65 : 0.3)) continue;
      if (!open) { ctx.save(); clipPath(); ctx.clip(); ctx.fillStyle = SHADOW; open = true; }
      baseZ = sh.gz * LEVEL_Z;
      sh.draw();
      baseZ = 0;
    }
    if (open) ctx.restore();
  }

  function drawBug(rig, style, t) {
    baseZ = (rig.zLevel ?? lvAt(rig.pos.x, rig.pos.y)) * LEVEL_Z;
    drawBugAt(rig, style, t);
    baseZ = 0;
  }

  // Shell colours per playable bug: [shell, shade, accent, limb].
  const KIND_COLORS = {
    cowboy: [C.rust0, C.void2, C.bone, C.limb],
    stag: [C.beetleB1, C.beetleB0, C.rust2, C.limb],
    jumper: [C.hull1, C.hull0, C.void1, C.void1],
    harvestman: [C.rust1, C.rust0, C.lamp0, C.rust1],
    mantis: [C.moss3, C.moss2, C.cell0, C.moss2],
    dung: [C.void2, C.void0, C.metal3, C.void1],
  };

  // Draws a playable bug; style.kind picks the species.
  function drawBugAt(rig, style, t) {
    const o = rig.opts, k = o.scale;
    const { x, y } = rig.pos, hd = rig.heading;
    const z = o.bodyHeight * k + rig.bodyDip;
    const c = Math.cos(hd), s = Math.sin(hd);
    const kind = style.kind || 'cowboy';
    let [shell, shade, accent, limb] = KIND_COLORS[kind];
    if (style.empty) { shell = shade; accent = C.metal1; } // out of charge: dull and dark
    const legStyle = { ...style, shade, limb, legW: kind === 'harvestman' ? 1.6 : kind === 'mantis' ? 2 : style.legW };
    // Point in the bug's frame: along its heading, to its side, at a height.
    const B = (along, side, zz) => P3(x + (c * along - s * side) * k, y + (s * along + c * side) * k, zz);
    const seg = (along, side, zz, a, b, color) => {
      ellipsePath(x + (c * along - s * side) * k, y + (s * along + c * side) * k, zz, hd, a * k, b * k);
      ctx.fillStyle = color; ctx.fill();
    };
    const line = (pts, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = px(width); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(...B(...q)) : ctx.moveTo(...B(...q)))); ctx.stroke();
    };
    const dot = (along, side, zz, r, color) => {
      const [qx, qy] = B(along, side, zz);
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(qx, qy, px(r), 0, Math.PI * 2); ctx.fill();
    };

    // Shadow and far legs.
    groundShadow(rig, (kind === 'harvestman' ? 0.16 : 0.3) * k, (kind === 'harvestman' ? 0.14 : 0.2) * k);
    const depth = (l) => { const hp = hipOf(rig, l); return hp.x + hp.y; };
    const mid = x + y;
    const legs = [...rig.legs].sort((a, b) => depth(a) - depth(b));
    for (const l of legs) if (depth(l) < mid) drawLeg(rig, l, legStyle);

    // Head position relative to the body (the head lags on its own follower).
    const hx = rig.headPos.x, hy = rig.headPos.y;
    const headAlong = ((hx - x) * c + (hy - y) * s) / k, headSide = (-(hx - x) * s + (hy - y) * c) / k;
    let ledAt = [-0.12, 0];
    const eyes = [];

    if (kind === 'cowboy') {
      // Flower chafer: dark shell with cream margins and a cream mid-line.
      seg(-0.05, 0, z - 0.05 * k, 0.28, 0.2, shade);
      seg(-0.05, 0, z, 0.27, 0.19, shell);
      ctx.strokeStyle = accent; ctx.lineWidth = px(2);
      ellipsePath(x - c * 0.05 * k, y - s * 0.05 * k, z + 0.005, hd, 0.22 * k, 0.15 * k); ctx.stroke();
      line([[0.12, 0, z + 0.01], [-0.24, 0, z + 0.01]], accent, 1.5);
      seg(0.17, 0, z + 0.01, 0.1, 0.15, shade);
      seg(0.17, 0, z + 0.02, 0.09, 0.14, shell);
      dot(0.2, 0.08, z + 0.03, 1, accent); dot(0.2, -0.08, z + 0.03, 1, accent);
      seg(headAlong, headSide, z, 0.06, 0.07, shell);
      for (const sd of [-1, 1]) line([[headAlong + 0.04, headSide + sd * 0.03, z + 0.03], [headAlong + 0.12, headSide + sd * 0.09, z + 0.07]], limb, 1);
      eyes.push([headAlong + 0.04, headSide + 0.04], [headAlong + 0.04, headSide - 0.04]);
      ledAt = [-0.1, 0];
    } else if (kind === 'stag') {
      // Stag beetle: chestnut wing cases, black thorax, wide head and antlers.
      seg(-0.1, 0, z - 0.05 * k, 0.29, 0.18, shade);
      seg(-0.1, 0, z, 0.28, 0.17, shell);
      line([[0.12, 0, z + 0.01], [-0.36, 0, z + 0.01]], shade, 1);
      line([[0.05, 0.08, z + 0.02], [-0.25, 0.1, z + 0.02]], accent, 1); // sheen
      seg(0.15, 0, z, 0.1, 0.16, C.void1);
      seg(0.15, 0, z + 0.015, 0.09, 0.15, C.void2);
      seg(headAlong, headSide, z + 0.01, 0.08, 0.14, C.void2);
      for (const sd of [-1, 1]) {
        const h0 = [headAlong + 0.05, headSide + sd * 0.07, z + 0.03];
        line([h0, [headAlong + 0.2, headSide + sd * 0.15, z + 0.06], [headAlong + 0.33, headSide + sd * 0.04, z + 0.05]], accent, 3);
        line([[headAlong + 0.2, headSide + sd * 0.14, z + 0.06], [headAlong + 0.22, headSide + sd * 0.07, z + 0.05]], accent, 1.5); // tine
      }
      eyes.push([headAlong + 0.02, headSide + 0.1], [headAlong + 0.02, headSide - 0.1]);
      ledAt = [-0.18, 0];
    } else if (kind === 'jumper') {
      // Jumping spider: striped abdomen, pale head with four big front eyes.
      seg(-0.16, 0, z - 0.04 * k, 0.18, 0.15, shade);
      seg(-0.16, 0, z, 0.17, 0.14, shell);
      for (const f of [-0.08, -0.16, -0.24]) line([[f, -0.08, z + 0.01], [f - 0.04, 0, z + 0.015], [f, 0.08, z + 0.01]], accent, 1.2);
      seg(0.07, 0, z, 0.12, 0.11, shade);
      seg(0.07, 0, z + 0.015, 0.11, 0.1, C.hull2);
      eyes.push([0.17, 0.04, 2.2], [0.17, -0.04, 2.2], [0.15, 0.08, 1], [0.15, -0.08, 1]);
      ledAt = [-0.16, 0];
    } else if (kind === 'harvestman') {
      // Daddy longlegs: a small round body with a darker saddle and an eye turret.
      seg(0, 0, z - 0.03 * k, 0.12, 0.11, shade);
      seg(0, 0, z, 0.11, 0.1, shell);
      seg(-0.01, 0, z + 0.01, 0.06, 0.05, shade);
      dot(0.05, 0, z + 0.05, 1.6, accent);
      eyes.push([0.06, 0.015, 0.9], [0.06, -0.015, 0.9]);
      ledAt = [-0.04, 0];
    } else if (kind === 'mantis') {
      // Mantis: long segmented abdomen, thin thorax, triangular head, folded arms.
      seg(-0.24, 0, z - 0.03 * k, 0.29, 0.11, shade);
      seg(-0.24, 0, z, 0.28, 0.1, shell);
      for (const f of [-0.1, -0.18, -0.26, -0.34, -0.42]) line([[f, -0.08, z + 0.01], [f, 0.08, z + 0.01]], shade, 1);
      line([[-0.02, 0, z + 0.02], [0.3, 0, z + 0.12]], shell, 5);
      seg(headAlong, headSide, z + 0.13, 0.06, 0.1, accent);
      for (const sd of [-1, 1]) {
        // Raptorial forelegs, folded as if praying.
        line([[0.22, sd * 0.03, z + 0.09], [0.34, sd * 0.06, z + 0.16], [0.3, sd * 0.03, z + 0.03]], accent, 2.2);
        line([[headAlong + 0.03, headSide + sd * 0.03, z + 0.15], [headAlong + 0.2, headSide + sd * 0.12, z + 0.26]], limb, 1);
      }
      eyes.push([headAlong + 0.01, headSide + 0.06, 1.3, z + 0.13], [headAlong + 0.01, headSide - 0.06, 1.3, z + 0.13]);
      ledAt = [-0.18, 0];
    } else {
      // Dung beetle: glossy black dome, shovel head.
      seg(-0.02, 0, z - 0.04 * k, 0.21, 0.18, shade);
      seg(-0.02, 0, z, 0.2, 0.17, shell);
      line([[0.06, 0.07, z + 0.02], [-0.14, 0.09, z + 0.02]], accent, 1.5); // gloss
      line([[0.04, -0.05, z + 0.02], [-0.1, -0.07, z + 0.02]], C.metal4, 1);
      line([[0.1, 0, z + 0.01], [-0.2, 0, z + 0.01]], shade, 1);
      seg(0.13, 0, z + 0.01, 0.09, 0.14, shell);
      seg(headAlong, headSide, z, 0.07, 0.11, shade);
      for (let i = -2; i <= 2; i++) dot(headAlong + 0.07, headSide + i * 0.035, z + 0.01, 0.9, shell); // serrated shovel
      eyes.push([headAlong + 0.02, headSide + 0.06], [headAlong + 0.02, headSide - 0.06]);
      ledAt = [-0.08, 0];
    }

    // Biometric implant: the heartbeat light on every bug's back.
    const [lx, ly] = B(ledAt[0], ledAt[1], z + 0.03);
    if (style.empty) {
      ctx.fillStyle = C.void2;
      ctx.beginPath(); ctx.arc(lx, ly, px(2.5), 0, Math.PI * 2); ctx.fill();
    } else {
      const bpm = 60 + style.led * 120;
      const ph = (rig.time * bpm / 60) % 1;
      let on = ph < 0.12 || (ph > 0.2 && ph < 0.3);
      if (style.overheated) on = hash(Math.floor(t * 20), 1) > 0.4;
      const hot = style.led > 0.5 || style.overheated;
      ctx.fillStyle = on ? (hot ? C.hot1 : C.elec1) : (hot ? C.hot0 : C.elec0);
      ctx.beginPath(); ctx.arc(lx, ly, px(2.5), 0, Math.PI * 2); ctx.fill();
      if (on) lights.push({ x: lx, y: ly, r: 34, color: hot ? C.hot1 : C.elec1, glow: 0.35 });
    }
    // Eyes glow while powered.
    for (const [ea, es, er = 1.2, ez = z + 0.04] of eyes) dot(ea, es, ez, er, style.empty ? C.void1 : C.elec1);
    if (!style.empty) {
      // Light the bug and the ground ahead without tinting its colours.
      const [ex, ey] = P3(hx + c * 0.6, hy + s * 0.6, 0);
      lights.push({ x: ex, y: ey, r: 85, color: C.elec1, glow: 0.04 }); // head lamp
      const [bx, by] = P3(x, y, z);
      lights.push({ x: bx, y: by, r: 60, color: C.bone, glow: 0.03 });
    }
    for (const l of legs) if (depth(l) >= mid) drawLeg(rig, l, legStyle);
  }

  // ---- the dung ball ----------------------------------------------------------
  // Rolls for real: a few specks fixed on a sphere, rotated by the distance
  // travelled about the axis across the direction of travel.
  const ballSpin = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], x: null, y: null };
  const SPECKS = Array.from({ length: 14 }, (_, i) => {
    const u = hash(i, 3), v = hash(i, 4);
    const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1);
    return [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph), i % 3];
  });
  function spinBall(b, radius) {
    if (ballSpin.x === null) { ballSpin.x = b.x; ballSpin.y = b.y; return; }
    const dx = b.x - ballSpin.x, dy = b.y - ballSpin.y, d = Math.hypot(dx, dy);
    ballSpin.x = b.x; ballSpin.y = b.y;
    if (d < 1e-6 || d > 2) return;
    // Rotation axis: horizontal, across the motion (world z is up).
    const ax = -dy / d, ay = dx / d, a = d / radius;
    const ca = Math.cos(a), sa = Math.sin(a), t1 = 1 - ca;
    const R = [ca + ax * ax * t1, ax * ay * t1, ay * sa, ay * ax * t1, ca + ay * ay * t1, -ax * sa, -ay * sa, ax * sa, ca];
    const M = ballSpin.m, out = new Array(9);
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) out[r * 3 + q] = R[r * 3] * M[q] + R[r * 3 + 1] * M[3 + q] + R[r * 3 + 2] * M[6 + q];
    ballSpin.m = out;
  }
  function drawBall(b, radius, bz = lvAt(b.x, b.y)) {
    spinBall(b, radius);
    const X = sx(b.x, b.y), base = sy(b.x, b.y) - bz * LEVEL_PX, floor = sy(b.x, b.y) - liftAt(b.x, b.y);
    const R = radius * Math.SQRT2 * HW;
    const Y = base - R * 0.9;
    if (previewMode) {
      ctx.fillStyle = C.void1;
      ctx.beginPath(); ctx.ellipse(X, floor, R * 1.05, R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    }
    const g = ctx.createRadialGradient(X - R * 0.35, Y - R * 0.4, R * 0.1, X, Y, R);
    g.addColorStop(0, C.rust1); g.addColorStop(0.45, C.grime); g.addColorStop(1, C.void1);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.fill();
    // Specks of straw and grit on the visible half.
    const M = ballSpin.m;
    const vx = 0.5, vy = 0.5, vz = 0.707; // toward the camera
    for (const [px0, py0, pz0, kind] of SPECKS) {
      const wx = M[0] * px0 + M[1] * py0 + M[2] * pz0;
      const wy = M[3] * px0 + M[4] * py0 + M[5] * pz0;
      const wz = M[6] * px0 + M[7] * py0 + M[8] * pz0;
      if (wx * vx + wy * vy + wz * vz < 0.15) continue;
      const ox = (wx - wy) * Math.SQRT1_2 * R, oy = (wx + wy) * Math.SQRT1_2 * R * 0.5 - wz * R * 0.85;
      ctx.fillStyle = kind === 0 ? C.lamp0 : kind === 1 ? C.moss2 : C.conc3;
      ctx.fillRect(X + ox - 1, Y + oy - 1, 2, 2);
    }
  }

  // ---- character previews (menu) ------------------------------------------------
  // Draws one walking bug on a patch of floor into its own small canvas,
  // snapped to the palette like the game.
  function renderPreview(target, rig, kind, t, ball) {
    const saved = { ctx, lights, map, baseZ, onePx, scale };
    const pc = target.getContext('2d', { willReadFrequently: true });
    ctx = pc; lights = []; map = null; baseZ = 0; previewMode = true;
    const s = 1; scale = s; onePx = 1 / s;
    pc.setTransform(1, 0, 0, 1, 0, 0);
    pc.fillStyle = C.void1; pc.fillRect(0, 0, target.width, target.height);
    pc.setTransform(s, 0, 0, s, Math.round(target.width / 2), Math.round(target.height / 2 + 8));
    for (let ty = -3; ty <= 2; ty++) for (let tx = -3; tx <= 2; tx++) drawFloor(tx, ty, t);
    const ballFirst = ball && ball.x + ball.y < rig.pos.x + rig.pos.y;
    if (ball && ballFirst) drawBall(ball, 0.32);
    drawBugAt(rig, { kind, legW: 3, led: 0.15, overheated: false, empty: false }, t);
    if (ball && !ballFirst) drawBall(ball, 0.32);
    pc.setTransform(1, 0, 0, 1, 0, 0);
    const img = pc.getImageData(0, 0, target.width, target.height);
    quantize(img.data, target.width, target.height, table, 6);
    pc.putImageData(img, 0, 0);
    ({ ctx, lights, map, baseZ, onePx, scale } = saved);
    previewMode = false;
  }



  // Spider: big abdomen behind, small thorax in front, eight legs, a row of
  // eyes that glow hot while it winds up and lunges.
  function drawSpider(rig, c, i, t) {
    if (c.mode === 'emerge') {
      // Crawling out of the vent: fades in as it rises.
      const prog = 1 - c.stateTime / Math.max(1e-6, c.stateTotal);
      ctx.save(); ctx.globalAlpha = Math.max(0.05, prog);
      ctx.translate(0, (1 - prog) * 8);
      drawSpiderBody(rig, c, i, t);
      ctx.restore();
      return;
    }
    drawSpiderBody(rig, c, i, t);
  }

  function drawSpiderBody(rig, c, i, t) {
    baseZ = (rig.zLevel ?? lvAt(rig.pos.x, rig.pos.y)) * LEVEL_Z;
    if (c.type === 'spider') drawSpiderAt(rig, c, i, t);
    else drawStainerAt(rig, c, t);
    baseZ = 0;
  }

  function drawSpiderAt(rig, c, i, t) {
    const o = rig.opts, k = o.scale, hd = rig.heading;
    const cs = Math.cos(hd), sn = Math.sin(hd);
    const { x, y } = rig.pos;
    const dead = !c.alive;
    // Cocoon spider: a glossy black widow.
    const [shell, shade] = dead ? [C.void1, C.void0] : [C.void2, C.void0];
    const z = (dead ? 0.04 : o.bodyHeight * k) + rig.bodyDip;
    groundShadow(rig, 0.32 * k, 0.26 * k);
    const style = { limb: dead ? C.void2 : C.limb, legW: 1.4, led: null, shade };
    const depth = (l) => { const hp = hipOf(rig, l); return hp.x + hp.y; };
    const legs = [...rig.legs].sort((a, b) => depth(a) - depth(b));
    if (dead) {
      // Legs curled in under the body.
      ctx.strokeStyle = C.void2; ctx.lineWidth = px(1.4);
      for (const l of rig.legs) {
        const hp = hipOf(rig, l);
        const fx2 = x + (l.foot.x - x) * 0.45, fy2 = y + (l.foot.y - y) * 0.45;
        ctx.beginPath(); ctx.moveTo(...P3(hp.x, hp.y, z)); ctx.quadraticCurveTo(...P3(fx2, fy2, 0.12 * k), ...P3(fx2 * 0.8 + x * 0.2, fy2 * 0.8 + y * 0.2, 0.02)); ctx.stroke();
      }
    } else {
      for (const l of legs) if (depth(l) < x + y) drawLeg(rig, l, style);
    }
    const ax = x - cs * 0.16 * k, ay = y - sn * 0.16 * k;
    ellipsePath(ax, ay, z - 0.04 * k, hd, 0.21 * k, 0.17 * k);
    ctx.fillStyle = shade; ctx.fill();
    ellipsePath(ax, ay, z + 0.02 * k, hd, 0.2 * k, 0.16 * k);
    ctx.fillStyle = shell; ctx.fill();
    // Hourglass-ish marking.
    ellipsePath(ax, ay, z + 0.03 * k, hd, 0.07 * k, 0.04 * k);
    ctx.fillStyle = dead ? C.blood0 : C.blood2; ctx.fill();
    const tx = x + cs * 0.08 * k, ty = y + sn * 0.08 * k;
    ellipsePath(tx, ty, z, hd, 0.11 * k, 0.09 * k);
    ctx.fillStyle = shell; ctx.fill();
    if (!dead) {
      const angry = c.mode === 'windup' || c.mode === 'lunge';
      for (const side of [-1, 1]) {
        const [ex, ey] = P3(tx + cs * 0.08 * k - sn * side * 0.035 * k, ty + sn * 0.08 * k + cs * side * 0.035 * k, z + 0.03);
        ctx.fillStyle = angry ? C.hot1 : C.hot0;
        ctx.fillRect(ex - onePx / 2, ey - onePx / 2, onePx, onePx);
      }
      // Eyes always glint a little, so spiders can be spotted in the dark.
      const [ex, ey] = P3(tx, ty, z);
      lights.push(angry
        ? { x: ex, y: ey, r: 26, color: C.hot1, glow: 0.35 }
        : { x: ex, y: ey, r: 12, color: C.hot0, glow: 0.3 });
      for (const l of legs) if (depth(l) >= x + y) drawLeg(rig, l, style);
    }
  }

  // Cotton stainer (Dysdercus): flat red oval, black triangle and wing spots,
  // pale seams, black membrane tip, long black antennae, six black legs.
  function drawStainerAt(rig, c, t) {
    const o = rig.opts, k = o.scale, hd = rig.heading;
    const cs = Math.cos(hd), sn = Math.sin(hd);
    const { x, y } = rig.pos;
    const dead = !c.alive;
    const z = (dead ? 0.03 : o.bodyHeight * k) + rig.bodyDip;
    const red = dead ? C.blood0 : c.elder ? C.blood1 : C.hot0, dark = C.void1;
    const B = (along, side, zz) => P3(x + (cs * along - sn * side) * k, y + (sn * along + cs * side) * k, zz);
    const seg = (along, side, zz, a, b, color) => {
      ellipsePath(x + (cs * along - sn * side) * k, y + (sn * along + cs * side) * k, zz, hd, a * k, b * k);
      ctx.fillStyle = color; ctx.fill();
    };
    const line = (pts, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = px(width); ctx.lineCap = 'round';
      ctx.beginPath(); pts.forEach((q, i2) => (i2 ? ctx.lineTo(...B(...q)) : ctx.moveTo(...B(...q)))); ctx.stroke();
    };
    groundShadow(rig, 0.28 * k, 0.16 * k);
    const style = { limb: dead ? C.void2 : C.limb, legW: 1.4, led: null, shade: dark };
    const depth = (l) => { const hp = hipOf(rig, l); return hp.x + hp.y; };
    const legs = [...rig.legs].sort((a, b) => depth(a) - depth(b));
    if (dead) {
      ctx.strokeStyle = C.void2; ctx.lineWidth = px(1.2);
      for (const l of rig.legs) {
        const hp = hipOf(rig, l);
        const fx2 = x + (l.foot.x - x) * 0.4, fy2 = y + (l.foot.y - y) * 0.4;
        ctx.beginPath(); ctx.moveTo(...P3(hp.x, hp.y, z)); ctx.quadraticCurveTo(...P3(fx2, fy2, 0.1 * k), ...P3(fx2 * 0.8 + x * 0.2, fy2 * 0.8 + y * 0.2, 0.02)); ctx.stroke();
      }
    } else {
      for (const l of legs) if (depth(l) < x + y) drawLeg(rig, l, style);
    }
    seg(-0.04, 0, z - 0.03 * k, 0.26, 0.14, dark);
    seg(-0.04, 0, z, 0.25, 0.13, red);
    if (!dead) {
      line([[0.1, 0.05, z + 0.012], [-0.16, 0.06, z + 0.012]], c.elder ? C.blood2 : C.hot1, 1.5); // glossy highlight
      if (c.elder) { // an elder: scarred, with a pale chevron and old wounds
        line([[0.02, -0.11, z + 0.014], [-0.1, 0, z + 0.014], [0.02, 0.11, z + 0.014]], C.hull2, 1.2);
        line([[-0.14, -0.08, z + 0.014], [-0.18, -0.02, z + 0.014]], C.void0, 1);
      }
      // Warning colours should read in the dark: a faint red glow of their own.
      const [gx, gy] = B(0, 0, z);
      lights.push({ x: gx, y: gy, r: 26, color: C.hot0, glow: 0.12 });
    }
    line([[0.12, 0.12, z + 0.005], [-0.18, 0.12, z + 0.005]], C.bone, 1); // pale seams
    line([[0.12, -0.12, z + 0.005], [-0.18, -0.12, z + 0.005]], C.bone, 1);
    seg(-0.24, 0, z + 0.006, 0.06, 0.09, dark); // membrane tip
    ctx.fillStyle = dark; ctx.beginPath(); // black triangle (scutellum)
    ctx.moveTo(...B(0.07, -0.06, z + 0.01)); ctx.lineTo(...B(0.07, 0.06, z + 0.01)); ctx.lineTo(...B(-0.05, 0, z + 0.01)); ctx.closePath(); ctx.fill();
    for (const sd of [-1, 1]) seg(-0.08, sd * 0.065, z + 0.01, 0.035, 0.03, dark); // wing spots
    seg(0.15, 0, z + 0.01, 0.07, 0.1, red); // pronotum
    line([[0.12, -0.09, z + 0.015], [0.12, 0.09, z + 0.015]], dark, 1.2); // collar
    line([[0.19, -0.07, z + 0.015], [0.19, 0.07, z + 0.015]], C.bone, 1);
    const hx = rig.headPos.x, hy = rig.headPos.y;
    const ha = ((hx - x) * cs + (hy - y) * sn) / k, hs = (-(hx - x) * sn + (hy - y) * cs) / k;
    seg(ha, hs, z + 0.01, 0.045, 0.045, red);
    const angry = c.mode === 'windup' || c.mode === 'lunge';
    for (const sd of [-1, 1]) {
      const [ex, ey] = B(ha + 0.02, hs + sd * 0.035, z + 0.03);
      ctx.fillStyle = dead ? C.void2 : angry ? C.hot1 : C.void0;
      ctx.fillRect(ex - onePx / 2, ey - onePx / 2, onePx, onePx);
      if (!dead) line([[ha + 0.03, hs + sd * 0.03, z + 0.03], [ha + 0.16, hs + sd * 0.1, z + 0.09], [ha + 0.3, hs + sd * 0.15, z + 0.05]], C.limb, 1);
    }
    if (angry) { const [ex, ey] = B(ha, hs, z); lights.push({ x: ex, y: ey, r: 24, color: C.hot1, glow: 0.3 }); }
    if (!dead) for (const l of legs) if (depth(l) >= x + y) drawLeg(rig, l, style);
  }

  // ---- cocoons with web turrets ---------------------------------------------------
  // A silk egg sac on a bolted anchor plate, wrapped in crossing strands, with a
  // riveted turret collar round its middle: a sensor head and barrel that
  // track the player, hydraulic hoses sunk into the silk. Damage shows: one hit
  // splits the silk and it weeps; two hits tear it open, the spider's eyes
  // glow inside and a leg pokes out. Hits flash it white and make it shudder.
  const cocoonHits = new Map(); // id -> time of the last hit (for flash/shake)
  function cocoonHit(id) { cocoonHits.set(id, 0); }
  function drawCocoon(c, t, state) {
    const X0 = sx(c.x, c.y), G = sy(c.x, c.y) - c.z * LEVEL_PX;
    const H = 32, W = 12;
    const since = cocoonHits.get(c.id);
    const shake = since !== undefined && since < 0.25 ? Math.sin(since * 80) * 2 * (1 - since / 0.25) : 0;
    const flash = since !== undefined && since < 0.12;
    const X = X0 + shake;
    // Anchor plate with bolts, and silk guy lines.
    ctx.fillStyle = C.metal0;
    ctx.beginPath(); ctx.ellipse(X0, G, W + 2, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.metal2; ctx.lineWidth = px(1); ctx.stroke();
    ctx.fillStyle = C.metal4;
    for (let i = 0; i < 5; i++) { const a = i * 1.257 + 0.3; ctx.fillRect(X0 + Math.cos(a) * (W - 1) - onePx / 2, G + Math.sin(a) * 3.5 - onePx / 2, onePx, onePx); }
    ctx.strokeStyle = C.hull1;
    for (let i = 0; i < 5; i++) {
      const a = i * 1.3 + 0.2;
      ctx.beginPath(); ctx.moveTo(X + Math.cos(a) * 7, G - 10);
      ctx.quadraticCurveTo(X0 + Math.cos(a) * 14, G - 2, X0 + Math.cos(a) * 20, G + Math.sin(a) * 7); ctx.stroke();
    }
    if (!c.alive) { drawHusk(c, X0, G, W, H); return; }
    const hp = c.hp ?? 3;
    const breathe = 1 + Math.sin(t * 2.2 + c.id) * 0.03;
    const cy = G - H * 0.55, rx = W * breathe, ry = H * 0.55;
    const ux = Math.cos(c.aim), uy = Math.sin(c.aim);
    const bx = (ux - uy) * HW, by = (ux + uy) * HH, bl = Math.hypot(bx, by) || 1;
    const dX = bx / bl, dY = by / bl;
    const back = ux + uy < 0;
    const collarY = G - H * 0.5;
    const charge = Math.min(1, c.charge / 0.45);
    const turret = () => {
      // Sensor head on the collar, barrel out of it.
      const hx = X + dX * (W - 1), hy = collarY + dY * 3;
      const ex = hx + dX * 13, ey = hy + dY * 13 * 0.6 - 1;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = C.metal0; ctx.lineWidth = px(6);
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = C.metal2; ctx.lineWidth = px(4);
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = C.metal4; ctx.lineWidth = px(1);
      ctx.beginPath(); ctx.moveTo(hx, hy - 1.5); ctx.lineTo(ex, ey - 1.5); ctx.stroke();
      for (let k = 0.3; k < 1; k += 0.3) { // cooling rings
        ctx.fillStyle = C.metal1; ctx.fillRect(hx + (ex - hx) * k - 1, hy + (ey - hy) * k - 3, 2, 6);
      }
      ctx.fillStyle = C.metal1;
      ctx.beginPath(); ctx.ellipse(hx, hy - 1, 5, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.metal3;
      ctx.beginPath(); ctx.ellipse(hx - 1, hy - 2.5, 3, 1.5, 0, 0, Math.PI * 2); ctx.fill();
      // Lens: dim, red when it sees you.
      ctx.fillStyle = c.sees ? C.hot1 : C.blood0;
      ctx.beginPath(); ctx.arc(hx + dX * 2.5, hy - 1 + dY, px(1.6), 0, Math.PI * 2); ctx.fill();
      if (c.sees) lights.push({ x: hx, y: hy, r: 18, color: C.hot1, glow: 0.25 });
      // Muzzle: charges from dark to white-hot.
      ctx.fillStyle = charge > 0.7 ? C.bone : charge > 0.35 ? C.hot1 : charge > 0 ? C.hot0 : C.void0;
      ctx.beginPath(); ctx.arc(ex, ey, px(2.2 + charge * 1.8), 0, Math.PI * 2); ctx.fill();
      if (charge > 0) lights.push({ x: ex, y: ey, r: 16 + charge * 26, color: C.hot1, glow: 0.2 + charge * 0.45 });
    };
    if (back) turret();
    // Pod: shaded silk, two layers of strands crossing, a loose tuft on top.
    const g = ctx.createRadialGradient(X - 4, cy - 9, 2, X, cy, ry * 1.1);
    g.addColorStop(0, flash ? C.bone : C.bone); g.addColorStop(0.45, flash ? C.bone : C.hull2); g.addColorStop(1, flash ? C.hull2 : C.hull0);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(X, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(X, cy, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
    ctx.lineWidth = px(1);
    for (let i = -6; i <= 6; i++) {
      ctx.strokeStyle = i % 2 ? C.hull1 : C.hull2;
      const o = i * 4 + Math.sin(t * 0.8 + i) * 0.8;
      ctx.beginPath(); ctx.moveTo(X - rx, cy + o - 6); ctx.quadraticCurveTo(X, cy + o + 5, X + rx, cy + o + 2); ctx.stroke();
      ctx.strokeStyle = C.hull1;
      ctx.beginPath(); ctx.moveTo(X - rx, cy + o + 4); ctx.quadraticCurveTo(X, cy + o - 6, X + rx, cy + o - 3); ctx.stroke();
    }
    // Something shifting inside.
    ctx.fillStyle = 'rgba(20,24,28,0.3)';
    ctx.beginPath(); ctx.ellipse(X + Math.sin(t * 0.9 + c.id) * 2.5, cy + 2, 4.5, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = C.hull2;
    for (let i = 0; i < 4; i++) { // tuft
      ctx.beginPath(); ctx.moveTo(X - 2 + i, cy - ry + 1);
      ctx.quadraticCurveTo(X - 6 + i * 4, cy - ry - 5, X - 8 + i * 5 + Math.sin(t * 2 + i) * 2, cy - ry - 3); ctx.stroke();
    }
    // Damage.
    if (hp <= 2) {
      // A split in the silk, weeping ichor.
      ctx.fillStyle = C.void0;
      ctx.beginPath(); ctx.moveTo(X - 3, cy - 9); ctx.lineTo(X + 1, cy - 4); ctx.lineTo(X - 2, cy + 1); ctx.lineTo(X + 2, cy + 7);
      ctx.lineTo(X + 4, cy + 6); ctx.lineTo(X + 1, cy + 1); ctx.lineTo(X + 4, cy - 4); ctx.lineTo(X, cy - 9); ctx.closePath(); ctx.fill();
      const drip = (t * 0.7 + c.id * 0.3) % 1;
      ctx.fillStyle = C.cell0; ctx.fillRect(X + 2, cy + 7, 1, 3 + drip * 10);
      ctx.fillStyle = C.cell1; ctx.fillRect(X + 2, cy + 9 + drip * 10, 2, 2);
    }
    if (hp <= 1) {
      // Torn open: flaps hang, eyes glow inside, a leg pokes out and twitches.
      ctx.fillStyle = C.void0;
      ctx.beginPath(); ctx.ellipse(X - 1, cy - 1, 6, 9, 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.hull1;
      ctx.beginPath(); ctx.moveTo(X - 7, cy - 6); ctx.lineTo(X - 11, cy + 6); ctx.lineTo(X - 6, cy + 3); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(X + 5, cy - 7); ctx.lineTo(X + 10, cy + 2); ctx.lineTo(X + 5, cy); ctx.closePath(); ctx.fill();
      for (const e of [-2, 1]) { ctx.fillStyle = C.hot1; ctx.fillRect(X + e, cy - 3, 1, 1); }
      lights.push({ x: X, y: cy - 3, r: 14, color: C.hot0, glow: 0.3 });
      const tw = Math.sin(t * 9 + c.id) * 0.4;
      ctx.strokeStyle = C.void2; ctx.lineWidth = px(1.5);
      ctx.beginPath(); ctx.moveTo(X + 2, cy + 2); ctx.lineTo(X + 9, cy - 2 + tw * 4); ctx.lineTo(X + 12, cy + 6 + tw * 3); ctx.stroke();
    }
    // Turret collar with rivets, hoses sunk into the silk.
    ctx.strokeStyle = C.void1; ctx.lineWidth = px(2);
    for (const sd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(X + sd * (W - 2), collarY); ctx.quadraticCurveTo(X + sd * (W + 3), collarY - 9, X + sd * 4, cy - ry + 6); ctx.stroke(); }
    ctx.fillStyle = C.metal0;
    ctx.beginPath(); ctx.ellipse(X, collarY + 1, W + 3, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.metal2;
    ctx.beginPath(); ctx.ellipse(X, collarY - 0.5, W + 2, 3.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.metal3; ctx.lineWidth = px(1); ctx.stroke();
    ctx.fillStyle = C.metal4;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (Math.sin(a) < -0.2) continue; // rivets on the visible front half
      ctx.fillRect(X + Math.cos(a) * (W + 1) - onePx / 2, collarY - 0.5 + Math.sin(a) * 2.8 - onePx / 2, onePx, onePx);
    }
    // Damage pips on the collar: one light per hit left.
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i < hp ? C.elec1 : C.void1;
      ctx.fillRect(X - 4 + i * 4 - 1, collarY + 2, 2, 1);
    }
    if (!back) turret();
    lights.push({ x: X, y: cy, r: 30, color: C.bone, glow: 0.05 });
  }

  // A broken cocoon: the lower shell with ragged edges, loose strands, the
  // collar fallen to one side with its barrel.
  function drawHusk(c, X, G, W, H) {
    ctx.fillStyle = C.hull0;
    ctx.beginPath(); ctx.moveTo(X - W, G - 4);
    for (let i = 0; i <= 10; i++) ctx.lineTo(X - W + (i / 10) * W * 2, G - 11 - (i % 2 ? 7 : 0) - hash(i, c.id) * 5);
    ctx.lineTo(X + W, G - 4); ctx.quadraticCurveTo(X, G + 4, X - W, G - 4); ctx.fill();
    ctx.fillStyle = C.void0; ctx.beginPath(); ctx.ellipse(X, G - 9, W - 3, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.hull2; ctx.lineWidth = px(1);
    for (let i = 0; i < 5; i++) {
      ctx.beginPath(); ctx.moveTo(X - W + i * 5, G - 14);
      ctx.quadraticCurveTo(X - W + i * 5 + 3, G - 22, X - W + i * 6 + hash(i, c.id, 2) * 6, G - 18); ctx.stroke();
    }
    ctx.fillStyle = C.metal0; ctx.beginPath(); ctx.ellipse(X + 15, G + 3, 9, 3.5, 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.metal2; ctx.beginPath(); ctx.ellipse(X + 15, G + 2, 7, 2.5, 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.metal1; ctx.lineWidth = px(3);
    ctx.beginPath(); ctx.moveTo(X + 11, G + 4); ctx.lineTo(X + 24, G + 1); ctx.stroke();
  }

  // Orb-web geometry around (X, Y): spokes, a spiral, sticky droplets.
  // r: radius (px), squash: vertical scale, turn: rotation, sag: px of droop.
  // Sized for the art resolution: one art pixel is 2 world px, so webs need a
  // radius of 12+ px and few spiral turns for the strands to stay apart.
  function orbWeb(X, Y, r, squash, turn, sag, t, seed, alpha, turns = 1.6, spokes = 7) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = px(1);
    ctx.strokeStyle = C.bone;
    ctx.beginPath();
    for (let i = 0; i < spokes; i++) {
      const a = turn + (i / spokes) * Math.PI * 2;
      const ex = X + Math.cos(a) * r, ey = Y + Math.sin(a) * r * squash;
      ctx.moveTo(X, Y); ctx.quadraticCurveTo((X + ex) / 2, (Y + ey) / 2 + sag * 0.5, ex, ey + sag * 0.3);
    }
    ctx.stroke();
    ctx.strokeStyle = C.hull1;
    ctx.beginPath();
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps, a = turn + f * turns * Math.PI * 2, rr = r * (0.18 + f * 0.82);
      const wob = Math.sin(t * 6 + i * 0.7 + seed) * 0.6;
      const x = X + Math.cos(a) * rr, y = Y + Math.sin(a) * rr * squash + sag * f * f + wob;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = C.bone;
    for (let i = 0; i < 4; i++) { // dew-like sticky droplets that glint
      const a = turn + hash(i, seed) * Math.PI * 2, rr = r * (0.3 + hash(i, seed, 1) * 0.65);
      if ((t * 3 + i) % 2 > 1.4) continue;
      ctx.fillRect(X + Math.cos(a) * rr - onePx / 2, Y + Math.sin(a) * rr * squash + sag * 0.4 - onePx / 2, onePx, onePx);
    }
    ctx.globalAlpha = 1;
  }

  // A web in flight: a tumbling orb web trailing a sagging silk thread back to
  // its turret, with a few droplets along the thread.
  function drawWeb(w, t, state) {
    const X = sx(w.x, w.y), Y = sy(w.x, w.y) - w.z * LEVEL_PX;
    const src = state.cocoons.find((c) => c.id === w.from);
    if (src && src.alive) {
      const SX = sx(src.x, src.y), SY = sy(src.x, src.y) - src.z * LEVEL_PX - 16;
      const mx = (SX + X) / 2, my = (SY + Y) / 2 + 8;
      ctx.globalAlpha = 0.55; ctx.strokeStyle = C.hull2; ctx.lineWidth = px(1);
      ctx.beginPath(); ctx.moveTo(SX, SY); ctx.quadraticCurveTo(mx, my, X, Y); ctx.stroke();
      ctx.fillStyle = C.bone;
      for (const f of [0.25, 0.5, 0.75]) {
        const qx = (1 - f) * (1 - f) * SX + 2 * f * (1 - f) * mx + f * f * X, qy = (1 - f) * (1 - f) * SY + 2 * f * (1 - f) * my + f * f * Y;
        ctx.fillRect(qx - onePx / 2, qy - onePx / 2, onePx, onePx);
      }
      ctx.globalAlpha = 1;
    }
    const pulse = 1 + Math.sin(t * 14 + w.id) * 0.12;
    orbWeb(X, Y, 13 * pulse, 0.7, t * 6 + w.id, 0, t, w.id, 0.9, 1.3, 6);
    lights.push({ x: X, y: Y, r: 18, color: C.bone, glow: 0.15 });
  }

  // The web wrapped round the player: an orb web over its back, anchored by
  // threads to its feet and the floor, trembling as the legs move. When the
  // slowdown ends it sags and fades; torn by a dash it bursts outward.
  const net = { strength: 0, torn: false };
  function webTorn() { net.torn = true; }
  function drawNet(rig, p, t, dt) {
    if (p.webbed > 0) { net.strength = 1; net.torn = false; } else net.strength = Math.max(0, net.strength - dt / (net.torn ? 0.3 : 0.7));
    if (net.strength <= 0) return;
    const o = rig.opts, k = o.scale;
    const zl = rig.zLevel ?? lvAt(rig.pos.x, rig.pos.y);
    baseZ = zl * LEVEL_Z;
    const z = o.bodyHeight * k + rig.bodyDip;
    const [cx, cy] = P3(rig.pos.x, rig.pos.y, z + 0.06);
    const fade = 1 - net.strength;
    const spread = net.torn ? 1 + fade * 1.2 : 1;
    const sag = fade * 10; // a dying web droops
    // Anchor threads to every foot and a ring on the floor.
    const anchors = rig.legs.map((l) => {
      const fg = rig.air ? 0 : (lvAt(l.foot.x, l.foot.y) - zl) * LEVEL_Z;
      return P3(l.foot.x, l.foot.y, l.lift + fg);
    });
    for (let i = 0; i < 6; i++) {
      const a = rig.heading + (i / 6) * Math.PI * 2 + 0.3;
      anchors.push(P3(rig.pos.x + Math.cos(a) * 0.45 * k, rig.pos.y + Math.sin(a) * 0.45 * k, 0));
    }
    ctx.globalAlpha = 0.8 * net.strength;
    ctx.strokeStyle = C.hull2; ctx.lineWidth = px(1);
    ctx.beginPath();
    anchors.forEach(([ax, ay], i) => {
      if (net.torn && i % 3 === 0) return; // snapped threads
      const ex = cx + (ax - cx) * spread, ey = cy + (ay - cy) * spread + sag;
      ctx.moveTo(cx, cy); ctx.quadraticCurveTo((cx + ex) / 2 + Math.sin(t * 7 + i) * 1.5, (cy + ey) / 2 + 3 + sag, ex, ey);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    // The orb itself, flattened over the body, slowly turning and trembling.
    const r = Math.max(16, (0.6 * k) * Math.SQRT2 * HW) * spread;
    orbWeb(cx, cy + 2, r, 0.55, t * 0.6 + Math.sin(t * 5) * 0.05, sag, t, 7, 0.75 * net.strength, 2, 8);
    baseZ = 0;
  }

  // Webs that hit a wall stay stuck there for a few seconds, then droop and fade.
  const splats = [];
  function webSplat(x, y, z) { splats.push({ x, y, z, life: 1, seed: Math.random() * 10 }); }
  function drawSplats(dt) {
    for (const sp of splats) {
      sp.life -= dt / 4;
      if (sp.life <= 0) continue;
      const X = sx(sp.x, sp.y), Y = sy(sp.x, sp.y) - sp.z * LEVEL_PX;
      orbWeb(X, Y, 15, 0.75, sp.seed, (1 - sp.life) * 6, 0, sp.seed, Math.min(1, sp.life * 2) * 0.8, 1.6, 7);
    }
    while (splats.length && splats[0].life <= 0) splats.shift();
  }

  // Jagged electric arc between two spiders; brighter as the wind-up completes.
  function drawArc(ra, rb, t, charge) {
    const za = ra.opts.bodyHeight * ra.opts.scale + (ra.zLevel ?? lvAt(ra.pos.x, ra.pos.y)) * LEVEL_Z;
    const zb = rb.opts.bodyHeight * rb.opts.scale + (rb.zLevel ?? lvAt(rb.pos.x, rb.pos.y)) * LEVEL_Z;
    const [x0, y0] = P3(ra.pos.x, ra.pos.y, za), [x1, y1] = P3(rb.pos.x, rb.pos.y, zb);
    const seg = 6, jitter = 3 + charge * 5, frame = Math.floor(t * 24);
    for (const [color, wdt] of [[C.elec1, 2], [C.elec2, 1]]) {
      ctx.strokeStyle = color; ctx.lineWidth = px(wdt);
      ctx.beginPath(); ctx.moveTo(x0, y0);
      for (let i = 1; i < seg; i++) {
        const f = i / seg;
        ctx.lineTo(x0 + (x1 - x0) * f + (hash(i, frame, 1) - 0.5) * jitter * 2, y0 + (y1 - y0) * f + (hash(i, frame, 2) - 0.5) * jitter * 2);
      }
      ctx.lineTo(x1, y1); ctx.stroke();
    }
    lights.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: 40 + charge * 30, color: C.elec1, glow: 0.25 + charge * 0.3 });
  }

  // ---- shelters ----------------------------------------------------------------
  // A round hatch sunk into the floor with an iris of blades. Open (warm light
  // inside, a beacon above) when the bug could sleep in it; the iris closes
  // while it curls up.
  function drawShelter(h, t, state) {
    const p = state.player;
    const X = sx(h.x, h.y), Y = sy(h.x, h.y) - h.z * LEVEL_PX;
    const ready = p.food >= 4 || (state.cycle.on && state.cycle.phase !== 'clear');
    const here = Math.hypot(p.x - h.x, p.y - h.y) < 0.5;
    const close = here ? Math.min(1, p.sleep) : 0;
    const R = HW * 0.42, r = R * (0.75 - 0.6 * close);
    // Rim.
    ctx.fillStyle = C.metal1; ctx.beginPath(); ctx.ellipse(X, Y, R + 4, (R + 4) / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.metal3; ctx.lineWidth = px(1); ctx.stroke();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.fillStyle = C.metal4; ctx.fillRect(X + Math.cos(a) * (R + 2) - onePx / 2, Y + Math.sin(a) * (R + 2) / 2 - onePx / 2, onePx, onePx); }
    // Blades.
    ctx.fillStyle = C.metal2; ctx.beginPath(); ctx.ellipse(X, Y, R, R / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ready ? C.lamp0 : C.void0; ctx.beginPath(); ctx.ellipse(X, Y, r, r / 2, 0, 0, Math.PI * 2); ctx.fill();
    if (ready) { ctx.fillStyle = C.lamp1; ctx.beginPath(); ctx.ellipse(X, Y, r * 0.5, r * 0.25, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = C.metal0; ctx.lineWidth = px(1);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + close * 1.2;
      ctx.beginPath(); ctx.moveTo(X + Math.cos(a) * r, Y + Math.sin(a) * r / 2); ctx.lineTo(X + Math.cos(a + 0.9) * R, Y + Math.sin(a + 0.9) * R / 2); ctx.stroke();
    }
    // Stripes on the rim so it reads from afar.
    ctx.strokeStyle = C.lamp0; ctx.lineWidth = px(2);
    for (const a0 of [0.3, 2.4, 4.4]) { ctx.beginPath(); ctx.ellipse(X, Y, R + 2, (R + 2) / 2, 0, a0, a0 + 0.5); ctx.stroke(); }
    if (ready) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
      lights.push({ x: X, y: Y - 4, r: 50 + pulse * 14, color: C.lamp1, glow: 0.25 + pulse * 0.15 });
      // A faint beacon so it can be found in the rain.
      ctx.globalAlpha = 0.18 + pulse * 0.1; ctx.fillStyle = C.lamp1;
      ctx.fillRect(X - 1, Y - 120, 2, 116); ctx.globalAlpha = 1;
    } else lights.push({ x: X, y: Y, r: 22, color: C.lamp0, glow: 0.08 });
  }

  // ---- gnat nests and gnats ---------------------------------------------------
  // A nest: a big ornamental curl-plant with a hanging pod the gnats live in.
  function drawNest(n, t) {
    const lift = liftAt(n.x, n.y), X = sx(n.x, n.y), Y = sy(n.x, n.y) - lift;
    const seed = Math.floor(n.x * 31 + n.y * 17);
    ornament(n.x - 0.15, n.y + 0.1, seed, lift, 1.4);
    ornament(n.x + 0.15, n.y - 0.1, seed + 5, lift, 1.1);
    const sway = Math.sin(t * 1.3 + seed) * 2;
    ctx.strokeStyle = C.moss2; ctx.lineWidth = px(1.5);
    ctx.beginPath(); ctx.moveTo(X, Y); ctx.quadraticCurveTo(X + 6, Y - 26, X + sway, Y - 34); ctx.stroke();
    ctx.fillStyle = C.beetleA0; ctx.beginPath(); ctx.ellipse(X + sway, Y - 28, 5, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.beetleA1; ctx.beginPath(); ctx.ellipse(X + sway - 1.5, Y - 30, 2, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.void0; ctx.fillRect(X + sway - 1, Y - 24, 2, 2);
    curl(X + sway, Y - 37, 4, -1, 1.2, C.moss3, 1.5);
    lights.push({ x: X + sway, y: Y - 26, r: 22, color: C.cell1, glow: 0.1 });
  }
  function drawGnat(g, t, alpha) {
    const x = g.px + (g.x - g.px) * alpha, y = g.py + (g.y - g.py) * alpha, h = (g.ph ?? g.h) + (g.h - (g.ph ?? g.h)) * alpha;
    const bob = Math.sin(t * 9 + g.id) * 2;
    const X = sx(x, y), Y = sy(x, y) - h * LEVEL_PX + bob;
    const flap = Math.floor(t * 30 + g.id) % 2;
    ctx.fillStyle = C.hull2;
    if (flap) { ctx.fillRect(X - 5, Y - 3, 4, 2); ctx.fillRect(X + 1, Y - 3, 4, 2); }
    else { ctx.fillRect(X - 5, Y, 4, 2); ctx.fillRect(X + 1, Y, 4, 2); }
    ctx.fillStyle = C.limb; ctx.fillRect(X - 1.5, Y - 2, 3, 4);
    // A glowing tail, brighter on the beat, so prey can be spotted in the dark.
    const pulse = 0.5 + 0.5 * Math.sin(t * 3 + g.id * 1.7);
    ctx.fillStyle = pulse > 0.5 ? C.cell2 : C.cell1; ctx.fillRect(X - 1, Y + 2, 2, 2);
    lights.push({ x: X, y: Y + 2, r: 14 + pulse * 6, color: C.cell1, glow: 0.15 + pulse * 0.15 });
  }

  // ---- rusted poles with cables between them (decor only) ----------------------
  const ruin = { map: null, poles: [], cables: [] };
  function buildRuins(state) {
    ruin.map = map; ruin.poles = []; ruin.cables = [];
    const taken = new Set();
    const mark = (o) => taken.add(Math.floor(o.y) * map.w + Math.floor(o.x));
    [...state.shards, ...state.vents, ...state.cocoons, ...(state.shelters || []), ...(state.nests || [])].forEach(mark);
    mark(map.spawn);
    const density = [0.02, 0.006, 0.03, 0.022, 0.006];
    for (let ty = 1; ty < map.h - 1; ty++) {
      for (let tx = 1; tx < map.w - 1; tx++) {
        const i = ty * map.w + tx;
        if (map.solid[i] || map.kind[i] || taken.has(i) || hash(tx, ty, 301) >= density[biomeAt(tx, ty)]) continue;
        ruin.poles.push({ tx, ty, x: tx + 0.25 + hash(tx, ty, 302) * 0.5, y: ty + 0.25 + hash(tx, ty, 303) * 0.5, h: 70 + hash(tx, ty, 304) * 40, lamp: hash(tx, ty, 305) < 0.3 });
      }
    }
    for (const a of ruin.poles) {
      let best = null, bd = 7;
      for (const b of ruin.poles) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (b !== a && d > 1.5 && d < bd) { best = b; bd = d; }
      }
      if (best && !ruin.cables.some((c) => c.a === best && c.b === a)) ruin.cables.push({ a, b: best, sag: 14 + hash(a.tx, a.ty, 306) * 20 });
    }
  }
  const poleTop = (q) => [sx(q.x, q.y), sy(q.x, q.y) - liftAt(q.x, q.y) - q.h];
  function drawPole(q, t) {
    const X = sx(q.x, q.y), Y = sy(q.x, q.y) - liftAt(q.x, q.y), top = Y - q.h;
    ctx.fillStyle = C.rust0; ctx.fillRect(X - 1.5, top, 3, q.h);
    ctx.fillStyle = C.rust1; ctx.fillRect(X - 1.5, top, 1, q.h);
    ctx.fillStyle = C.void1; ctx.fillRect(X - 3, Y - 3, 6, 3); // foot plate
    ctx.fillStyle = C.rust0; ctx.fillRect(X - 9, top + 6, 18, 2); // crossbar
    ctx.fillStyle = C.rust2; ctx.fillRect(X - 9, top + 6, 18, 1);
    for (const d of [-8, 7]) { ctx.fillStyle = C.metal3; ctx.fillRect(X + d, top + 3, 1, 3); } // insulators
    if (q.lamp) {
      const on = hash(Math.floor(t * 5), q.tx, q.ty) > 0.15;
      ctx.fillStyle = on ? C.lamp1 : C.lamp0; ctx.fillRect(X + 2, top + 10, 3, 3);
      if (on) lights.push({ x: X + 3, y: top + 11, r: 70, color: C.lamp1, glow: 0.2 });
    }
  }
  function drawCables(onScreenXY) {
    ctx.strokeStyle = C.limb; ctx.lineWidth = px(1);
    for (const c of ruin.cables) {
      const [ax, ay] = poleTop(c.a), [bx, by] = poleTop(c.b);
      if (!onScreenXY(ax, ay) && !onScreenXY(bx, by)) continue;
      const mx = (ax + bx) / 2, my = (ay + by) / 2 + c.sag;
      for (const d of [-8, 7]) {
        ctx.beginPath(); ctx.moveTo(ax + d, ay + 3); ctx.quadraticCurveTo(mx + d, my + 3, bx + d, by + 3); ctx.stroke();
      }
    }
  }

  // Noise ripples and other short floor rings.
  function noiseRing(x, y, r) { fx.rings.push({ x, y, z: lvAt(x, y), r: Math.min(r, 4), life: 1 }); }
  function drawRings(dt) {
    for (const q of fx.rings) {
      q.life -= dt * 1.4;
      const k = 1 - q.life, R = q.r * k;
      ctx.globalAlpha = Math.max(0, q.life) * 0.35; ctx.strokeStyle = C.metal4; ctx.lineWidth = px(1);
      ctx.beginPath(); ctx.ellipse(sx(q.x, q.y), sy(q.x, q.y) - q.z * LEVEL_PX, R * HW * Math.SQRT2 * 0.7, R * HH * Math.SQRT2 * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    fx.rings = fx.rings.filter((q) => q.life > 0);
  }
  function eatFx(x, y, z) {
    const X = sx(x, y), Y = sy(x, y) - (z ?? lvAt(x, y)) * LEVEL_PX;
    for (let i = 0; i < 6; i++) fx.particles.push({ x: X, y: Y, vx: (Math.random() - 0.5) * 60, vy: -20 - Math.random() * 30, life: 1, fade: 2.5, grav: 80, color: i % 2 ? C.cell1 : C.metal4, size: 2 });
  }

  // ---- vents ---------------------------------------------------------------
  function drawVent(v, t, dt) {
    const tx = Math.floor(v.x), ty = Math.floor(v.y);
    const lift = liftAt(v.x, v.y);
    ctx.save(); ctx.translate(0, -lift);
    diamond(tx, ty, 0, 0.12);
    ctx.fillStyle = C.void0; ctx.fill();
    ctx.strokeStyle = C.metal3; ctx.lineWidth = px(1.5); ctx.stroke();
    // Slats.
    ctx.strokeStyle = C.metal1; ctx.lineWidth = px(2);
    for (let i = 1; i < 5; i++) {
      const k = 0.12 + (i / 5) * 0.76;
      ctx.beginPath();
      ctx.moveTo(sx(tx + 0.18, ty + k), sy(tx + 0.18, ty + k));
      ctx.lineTo(sx(tx + 0.82, ty + k), sy(tx + 0.82, ty + k));
      ctx.stroke();
    }
    ctx.restore();
    // Something red breathes down there.
    const glow = 0.5 + 0.5 * Math.sin(t * 1.7 + v.x);
    lights.push({ x: sx(v.x, v.y), y: sy(v.x, v.y) - lift, r: 34, color: C.blood2, glow: 0.12 + glow * 0.12 });
    if (Math.random() < dt * 1.5) ventPuff(v, 1);
  }

  function ventPuff(v, n = 10) {
    const X = sx(v.x, v.y), Y = sy(v.x, v.y) - liftAt(v.x, v.y);
    for (let i = 0; i < n; i++) {
      fx.particles.push({
        x: X + (Math.random() - 0.5) * 24, y: Y - 2, vx: (Math.random() - 0.5) * 20, vy: -20 - Math.random() * 25,
        life: 1, fade: 0.9 + Math.random() * 0.6, grav: -8, color: i % 3 ? C.metal3 : C.metal4, size: 3,
      });
    }
  }

  // ---- blood layer ---------------------------------------------------------
  // Splatters are generated once, when the kill happens, as lists of floor
  // dots per tile, and redrawn with their tile every frame, so blood on a
  // raised floor stays on that floor. Slopes and walls get none.
  const decal = { map: null, tiles: new Map() };

  function resetDecals(m) { decal.map = m; decal.tiles = new Map(); }

  function addDot(x, y, r, color) {
    const m = decal.map, tx = Math.floor(x), ty = Math.floor(y);
    if (isSolid(m, tx, ty) || m.kind[ty * m.w + tx]) return;
    const key = ty * m.w + tx;
    if (!decal.tiles.has(key)) decal.tiles.set(key, []);
    decal.tiles.get(key).push([x, y, r, color]);
  }

  // A circle of radius r tiles lying on the floor.
  function floorDot(x, y, r, color, lift = 0) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(sx(x, y), sy(x, y) - lift, r * Math.SQRT2 * HW, r * Math.SQRT2 * HH, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawTileBlood(tx, ty, lift, clip) {
    if (decal.map !== map) return;
    const dots = decal.tiles.get(ty * map.w + tx);
    if (!dots) return;
    if (clip) { ctx.save(); diamond(tx, ty, lift); ctx.clip(); }
    for (const [x, y, r, color] of dots) floorDot(x, y, r, color, lift);
    if (clip) ctx.restore();
  }

  function bloodSplatter(m, x, y, dirX, dirY) {
    if (decal.map !== m) resetDecals(m);
    const z0 = groundLevel(m, x, y);
    // Blood stays on the floor it was spilled on.
    const open = (px2, py2) => !isSolid(m, Math.floor(px2), Math.floor(py2)) && Math.abs(groundLevel(m, px2, py2) - z0) < 0.1;
    const dot = (px2, py2, r, c) => { if (open(px2, py2)) addDot(px2, py2, r, c); };
    const rnd = Math.random;
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    const aim = Math.hypot(dirX, dirY) > 0.1 ? Math.atan2(dirY, dirX) : rnd() * Math.PI * 2;
    // Pool where it died.
    for (let i = 0; i < 6; i++) dot(x + gauss() * 0.12, y + gauss() * 0.12, 0.08 + rnd() * 0.14, i < 2 ? C.blood0 : C.blood1);
    // Streaks thrown along the dash, as tapering runs of dots.
    for (let i = 0; i < 6; i++) {
      const a = aim + gauss() * 0.35, len = 0.3 + rnd() * 0.8, w0 = 0.04 + rnd() * 0.03;
      const color = rnd() < 0.3 ? C.blood2 : C.blood1;
      for (let f = 0; f <= 1; f += 0.08) {
        const px2 = x + Math.cos(a) * len * f, py2 = y + Math.sin(a) * len * f;
        if (!open(px2, py2)) break;
        addDot(px2, py2, w0 * (1 - f * 0.6), color);
      }
    }
    // Droplets: most land close, a few fly far; smaller the further they go.
    // Sized so even small drops survive the pixel filter (>= ~1 art pixel).
    const n = 22 + Math.floor(rnd() * 14);
    for (let i = 0; i < n; i++) {
      const a = aim + gauss() * 0.9;
      const d = Math.min(2.4, 0.2 - Math.log(1 - rnd() * 0.98) * 0.55);
      const r = Math.max(0.03, 0.09 - d * 0.03) * (0.6 + rnd() * 0.8);
      dot(x + Math.cos(a) * d, y + Math.sin(a) * d, r, rnd() < 0.25 ? C.blood2 : C.blood1);
    }
  }

  // When a corpse leaves the simulation, its dried husk stays on the floor.
  function bakeHusk(m, x, y) {
    if (decal.map !== m) resetDecals(m);
    const hd = Math.random() * Math.PI * 2;
    addDot(x - Math.cos(hd) * 0.06, y - Math.sin(hd) * 0.06, 0.11, C.void2);
    addDot(x + Math.cos(hd) * 0.06, y + Math.sin(hd) * 0.06, 0.06, C.void1);
    for (let i = 0; i < 8; i++) {
      const a = hd + (i / 8) * Math.PI * 2 + 0.2;
      for (let f = 0.3; f <= 1; f += 0.25) {
        const bend = a + f * 0.6;
        addDot(x + Math.cos(bend) * 0.17 * f, y + Math.sin(bend) * 0.17 * f, 0.02, C.void1);
      }
    }
  }

  // ---- particles & weather --------------------------------------------------
  function burst(x, y) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      fx.particles.push({
        x: sx(x, y), y: sy(x, y) - liftAt(x, y) - 10, vx: Math.cos(a) * 80, vy: Math.sin(a) * 50 - 50,
        life: 1, fade: 2, grav: 200, color: i % 3 ? C.cell2 : C.elec2,
      });
    }
  }

  function puff(x, y, z, n, colors, speed = 50, rise = 20) {
    const X = sx(x, y), Y = sy(x, y) - z * LEVEL_PX;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      fx.particles.push({
        x: X, y: Y - 2, vx: Math.cos(a) * speed * (0.6 + Math.random() * 0.6), vy: Math.sin(a) * speed * 0.45 - rise,
        life: 1, fade: 1.6 + Math.random(), grav: 60, color: colors[i % colors.length], size: 2 + (i % 2),
      });
    }
  }
  // Dust ring when something lands; bigger for bigger falls.
  const dust = (x, y, z, height) => puff(x, y, z, Math.min(24, 6 + Math.round(height * 6)), [C.conc3, C.metal3, C.conc2], 40 + height * 20, 8);
  const cocoonBurst = (x, y, z) => { puff(x, y, z + 0.6, 22, [C.bone, C.hull2, C.hull1], 70, 40); puff(x, y, z + 0.6, 8, [C.elec2, C.hot1], 110, 50); };
  const muzzle = (x, y, z) => puff(x, y, z + 0.6, 6, [C.hot1, C.bone], 50, 10);

  function hitFx(x, y) {
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      fx.particles.push({
        x: sx(x, y), y: sy(x, y) - liftAt(x, y) - 8, vx: Math.cos(a) * 110, vy: Math.sin(a) * 70 - 40,
        life: 1, fade: 2.5, grav: 260, color: i % 2 ? C.hot1 : C.bone,
      });
    }
  }

  function splat(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      fx.particles.push({
        x: sx(x, y), y: sy(x, y) - liftAt(x, y) - 6, vx: Math.cos(a) * 60, vy: Math.sin(a) * 40 - 30,
        life: 1, fade: 1.6, grav: 220, color: i % 3 ? C.moss2 : C.elec2, size: i % 3 ? 3 : 2,
      });
    }
  }

  function updateFx(dt, p, ix, iy, rig) {
    for (const q of fx.particles) {
      q.x += q.vx * dt; q.y += q.vy * dt; q.vy += q.grav * dt; q.life -= dt * q.fade;
    }
    fx.particles = fx.particles.filter((q) => q.life > 0);
    for (const g of fx.trail) g.life -= dt * 4;
    fx.trail = fx.trail.filter((g) => g.life > 0);
    if (p.dashTime > 0) fx.trail.push({ x: ix, y: iy, life: 1 });
    if (rig && p.heat > 0.6) {
      // Overheating: steam rises off the shell, sparks spit from the joints.
      const n = p.overheated ? 3 : 1;
      for (let i = 0; i < n; i++) {
        if (Math.random() > dt * 30) continue;
        const [X, Y] = P3(rig.pos.x, rig.pos.y, rig.opts.bodyHeight + (rig.zLevel ?? lvAt(rig.pos.x, rig.pos.y)) * LEVEL_Z);
        const steam = Math.random() < 0.6;
        fx.particles.push(steam
          ? { x: X + (Math.random() - 0.5) * 12, y: Y - 4, vx: (Math.random() - 0.5) * 10, vy: -25, life: 1, fade: 1.2, grav: -10, color: C.metal4, size: 3 }
          : { x: X, y: Y, vx: (Math.random() - 0.5) * 120, vy: -60 - Math.random() * 60, life: 1, fade: 3, grav: 300, color: Math.random() < 0.5 ? C.elec2 : C.hot1 });
      }
    }
  }

  // Rain follows the cycle: drizzle when clear, heavier in the warning, and
  // in the downpour dense slanted streaks, sheets of water and splashes.
  function rain(lw, lh, amount, dt, storm = 0) {
    const want = Math.round(amount * (0.35 + storm * 3) * (lw * lh) / 900);
    const slant = 0.25 + storm * 0.35, speed = 1 + storm * 1.6, len = 1 + storm * 3;
    while (fx.drops.length < want) {
      fx.drops.push({ x: Math.random() * (lw + 80), y: Math.random() * lh, v: 160 + Math.random() * 120, len: 2 + Math.random() * 3 });
    }
    fx.drops.length = Math.min(fx.drops.length, want);
    ctx.strokeStyle = C.metal3; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of fx.drops) {
      d.y += d.v * speed * dt; d.x -= d.v * speed * slant * dt;
      if (d.y > lh || d.x < -8) {
        if (storm > 0.3 && Math.random() < storm) fx.splashes.push({ x: d.x, y: Math.min(d.y, lh - 2), life: 1 });
        d.y = -5; d.x = Math.random() * (lw + 80);
      }
      ctx.moveTo(Math.round(d.x), Math.round(d.y));
      ctx.lineTo(Math.round(d.x + d.len * len * slant), Math.round(d.y - d.len * len));
    }
    ctx.stroke();
    if (storm > 0.3) {
      // Splashes across the ground, not only where streaks end.
      for (let i = 0; i < storm * 6; i++) fx.splashes.push({ x: Math.random() * lw, y: Math.random() * lh, life: 1 });
      ctx.fillStyle = C.metal4;
      for (const q of fx.splashes) {
        q.life -= dt * 6;
        ctx.globalAlpha = Math.max(0, q.life) * 0.7;
        ctx.fillRect(Math.round(q.x) - 1, Math.round(q.y), 1, 1); ctx.fillRect(Math.round(q.x) + 1, Math.round(q.y), 1, 1);
        ctx.fillRect(Math.round(q.x), Math.round(q.y) - 1, 1, 1);
      }
      ctx.globalAlpha = 1;
      fx.splashes = fx.splashes.filter((q) => q.life > 0);
    } else fx.splashes.length = 0;
    if (storm >= 0.99) {
      // Sheets of water sweeping across.
      while (fx.sheets.length < 4) fx.sheets.push({ x: Math.random() * lw, w: 10 + Math.random() * 30, v: 20 + Math.random() * 40 });
      ctx.fillStyle = C.metal3;
      for (const q of fx.sheets) {
        q.x -= q.v * dt; if (q.x < -q.w) { q.x = lw + Math.random() * 40; q.w = 10 + Math.random() * 30; }
        ctx.globalAlpha = 0.07; ctx.fillRect(Math.round(q.x), 0, Math.round(q.w), lh);
      }
      ctx.globalAlpha = 1;
    } else fx.sheets.length = 0;
  }

  // ---- frame ---------------------------------------------------------------
  function draw(state, view, rigs, t, look, dt = 0) {
    map = state.map;
    const p = state.player;
    scale = 1 / look.pixel; // art pixels per world pixel: fixed, zoom-independent
    onePx = look.pixel;
    // Device pixels per art pixel: whole numbers only, so every art pixel is the same size.
    const up = Math.max(1, Math.round(view.zoom * dpr * look.pixel));
    const lw = Math.max(1, Math.ceil(canvas.width / up)), lh = Math.max(1, Math.ceil(canvas.height / up));
    if (low.width !== lw || low.height !== lh) {
      low.width = lw; low.height = lh; light.width = lw; light.height = lh;
    }
    lights = [];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = C.void0; ctx.fillRect(0, 0, lw, lh);

    // Snap the camera to whole low-res pixels so walls don't shimmer.
    const ox = Math.round(lw / 2 - view.camX * scale), oy = Math.round(lh / 2 - view.camY * scale);

    // Distant machinery, drifting slower than the world.
    for (let i = 0; i < 14; i++) {
      const tw = (6 + hash(i, 1) * 30) * scale * 2;
      const period = lw + 80;
      const bx = ((((hash(i, 2) * period * 3 + ox * 0.3) % period) + period) % period) - 40;
      const top = lh * (0.1 + hash(i, 3) * 0.5) + oy * 0.05;
      ctx.fillStyle = i % 3 ? C.void1 : C.void2;
      ctx.fillRect(Math.round(bx), Math.round(top), Math.round(tw), lh);
      if (hash(i, 4) < 0.5) {
        ctx.fillStyle = (t * 0.7 + hash(i, 5)) % 1 < 0.5 ? C.lamp0 : C.void2;
        ctx.fillRect(Math.round(bx + tw / 2), Math.round(top + 6), 1, 1);
      }
    }

    ctx.setTransform(scale, 0, 0, scale, ox, oy);

    // Slab edge under the level.
    ctx.fillStyle = C.conc0;
    ctx.beginPath();
    ctx.moveTo(sx(0, map.h), sy(0, map.h));
    ctx.lineTo(sx(map.w, map.h), sy(map.w, map.h));
    ctx.lineTo(sx(map.w, 0), sy(map.w, 0));
    ctx.lineTo(sx(map.w, 0), sy(map.w, 0) + 22);
    ctx.lineTo(sx(map.w, map.h), sy(map.w, map.h) + 22);
    ctx.lineTo(sx(0, map.h), sy(0, map.h) + 22);
    ctx.closePath(); ctx.fill();

    // Shadows of everything that stands, collected before the floor is drawn.
    shadows = [];
    {
      const pr0 = rigs.player, k0 = pr0.opts.scale, hm = rigs.kind === 'harvestman';
      rigShadow(pr0, (hm ? 0.16 : 0.3) * k0, (hm ? 0.14 : 0.2) * k0);
      for (const c of state.critters) {
        const rig = rigs.critters.get(c.id);
        if (rig) rigShadow(rig, (c.type === 'spider' ? 0.32 : 0.28) * rig.opts.scale, (c.type === 'spider' ? 0.26 : 0.16) * rig.opts.scale);
      }
      const b = p.ball;
      if (b) {
        const R = (rigs.ballRadius || 0.32) * Math.SQRT2 * HW;
        const bz = (b.pz ?? b.z) + (b.z - (b.pz ?? b.z)) * view.alpha;
        discShadow(b.x, b.y, R * 1.05, R * 0.5, 1 / (1 + Math.max(0, bz - lvAt(b.x, b.y)) * 1.5));
      }
      for (const sc of state.shards) if (!sc.taken) discShadow(sc.x, sc.y, sc.big ? 12 : 7, sc.big ? 6 : 3.5);
      for (const c of state.cocoons) discShadow(c.x, c.y, 16, 6.5);
    }

    // Only tiles on screen are drawn (the arena is far bigger than the view).
    const halfW = lw / 2 / scale + HW * 2, halfH = lh / 2 / scale;
    const camX = view.camX, camY = view.camY;
    const onScreen = (tx, ty, top = 0) => {
      const X = (tx - ty) * HW, Y = (tx + ty) * HH;
      return X > camX - halfW && X < camX + halfW && Y + TILE_H * 2 > camY - halfH && Y - top - 60 < camY + halfH;
    };
    // Ground level: flat level-0 floor first, with its blood, vents and shadows.
    const ground = (tx, ty) => { const i = ty * map.w + tx; return !map.solid[i] && !map.kind[i] && map.level[i] === 0; };
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) if (ground(tx, ty) && onScreen(tx, ty)) drawFloor(tx, ty, t);
    }
    if (decal.map === map) {
      for (const key of decal.tiles.keys()) {
        const tx = key % map.w, ty = Math.floor(key / map.w);
        if (ground(tx, ty) && onScreen(tx, ty)) drawTileBlood(tx, ty, 0, false);
      }
    }
    for (const v of state.vents) if (ground(Math.floor(v.x), Math.floor(v.y))) drawVent(v, t, dt);
    for (const hs of state.shelters || []) if (ground(Math.floor(hs.x), Math.floor(hs.y)) && onScreen(Math.floor(hs.x), Math.floor(hs.y))) drawShelter(hs, t, state);
    ctx.fillStyle = SHADOW;
    for (const sh of shadows) if (sh.gz < 0.05 && ground(Math.floor(sh.x), Math.floor(sh.y))) { sh.draw(); }

    // Dash afterimage.
    const pr = rigs.player;
    for (const g of fx.trail) {
      baseZ = lvAt(g.x, g.y) * LEVEL_Z;
      ellipsePath(g.x, g.y, pr.opts.bodyHeight, pr.heading, 0.26, 0.16);
      ctx.globalAlpha = g.life * 0.5; ctx.fillStyle = C.elec0; ctx.fill(); ctx.globalAlpha = 1;
    }
    baseZ = 0;

    // Painter's order by x + y. Columns (walls, raised floors, slopes) use
    // their centre; creatures and batteries their feet.
    const items = [];
    const colTop = (tx, ty) => {
      const i = ty * map.w + tx;
      return map.solid[i] ? map.level[i] + WALL_H / LEVEL_PX : map.level[i] + (map.kind[i] ? 1 : 0);
    };
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        if (ground(tx, ty)) continue;
        const top = colTop(tx, ty);
        if (onScreen(tx, ty, top * LEVEL_PX)) items.push({ d: tx + ty + 1, k: 0, tx, ty, top });
      }
    }
    for (const v of state.vents) {
      const tx = Math.floor(v.x), ty = Math.floor(v.y);
      if (!ground(tx, ty)) items.push({ d: tx + ty + 1, k: 0.5, v });
    }
    for (const hs of state.shelters || []) {
      const tx = Math.floor(hs.x), ty = Math.floor(hs.y);
      if (!ground(tx, ty)) items.push({ d: tx + ty + 1, k: 0.6, shelter: hs });
    }
    // Something standing on a column draws after it. With nothing taller just
    // in front, it also draws after its same-height neighbours, so its legs
    // aren't cut off by the next tile of the same floor.
    const standDepth = (x, y) => {
      const tx = Math.floor(x), ty = Math.floor(y), z = lvAt(x, y);
      let d = x + y;
      if (!ground(tx, ty)) d = Math.max(d, tx + ty + 1.001);
      const taller = [[1, 0], [0, 1], [1, 1]].some(([a, b]) => {
        const nx = tx + a, ny = ty + b;
        return nx < map.w && ny < map.h && colTop(nx, ny) > z + 0.2;
      });
      return taller ? d : Math.max(d, tx + ty + 1.6);
    };
    for (const s of state.shards) if (!s.taken) items.push({ d: standDepth(s.x, s.y), k: 1, s });
    if (ruin.map !== map) buildRuins(state);
    for (const q of ruin.poles) if (onScreen(q.tx, q.ty, q.h)) items.push({ d: standDepth(q.x, q.y), k: 1.1, pole: q });
    for (const n of state.nests || []) if (onScreen(Math.floor(n.x), Math.floor(n.y), 60)) items.push({ d: standDepth(n.x, n.y), k: 1.05, nest: n });
    for (const g of state.gnats || []) if (onScreen(Math.floor(g.x), Math.floor(g.y), 40)) items.push({ d: standDepth(g.x, g.y) + 0.2, k: 5, gnat: g });
    for (const c of state.critters) {
      const rig = rigs.critters.get(c.id);
      if (rig) items.push({ d: standDepth(rig.pos.x, rig.pos.y) - (c.alive ? 0 : 0.01), k: 3, rig, i: c.id, c });
    }
    if (p.ball) items.push({ d: standDepth(p.ball.x, p.ball.y), k: 1.5, b: p.ball, bz: (p.ball.pz ?? p.ball.z) + (p.ball.z - (p.ball.pz ?? p.ball.z)) * view.alpha });
    for (const c of state.cocoons) items.push({ d: standDepth(c.x, c.y), k: 1.2, cocoon: c });
    for (const w of state.webs) items.push({ d: standDepth(w.x, w.y) + 0.3, k: 4, web: w });
    const pd = standDepth(pr.pos.x, pr.pos.y);
    const pz = pr.zLevel ?? lvAt(pr.pos.x, pr.pos.y);
    items.push({ d: pd, k: 2 });
    items.sort((a, b) => a.d - b.d || a.k - b.k);

    let anyFade = false;
    for (const it of items) {
      if (it.k === 0) {
        // Columns taller than the player, in front of it, fade so it stays visible.
        const fade = it.d > pd && it.top > pz + 0.2 && hidesPlayer(it.tx, it.ty, pr, it.top * LEVEL_PX);
        anyFade ||= fade;
        if (map.solid[it.ty * map.w + it.tx]) drawWall(it.tx, it.ty, t, fade ? 0.35 : 1);
        else drawColumn(it.tx, it.ty, t, fade ? 0.35 : 1);
      } else if (it.k === 0.5) drawVent(it.v, t, dt);
      else if (it.k === 0.6) drawShelter(it.shelter, t, state);
      else if (it.k === 1.1) drawPole(it.pole, t);
      else if (it.k === 1.05) drawNest(it.nest, t);
      else if (it.k === 5) drawGnat(it.gnat, t, view.alpha ?? 1);
      else if (it.k === 1) drawCell(it.s, t);
      else if (it.k === 1.5) drawBall(it.b, rigs.ballRadius || 0.32, it.bz);
      else if (it.k === 1.2) drawCocoon(it.cocoon, t, state);
      else if (it.k === 4) drawWeb(it.web, t, state);
      else if (it.k === 3) drawSpider(it.rig, it.c, it.i, t);
      else {
        const empty = p.charges <= 0;
        drawBug(pr, {
          kind: rigs.kind,
          shell: empty ? C.hull0 : C.hull1, shade: empty ? C.metal1 : C.hull0, limb: C.limb,
          legW: 3, led: p.heat, overheated: p.overheated, empty,
        }, t);
        drawNet(pr, p, t, dt);
      }
    }

    // Pairs charging an attack are linked by a crackling arc.
    for (const c of state.critters) {
      if (!c.alive || c.mode !== 'windup' || c.role !== 0) continue;
      const o = state.critters.find((q) => q.id === c.partner);
      const ra = rigs.critters.get(c.id), rb = o && rigs.critters.get(o.id);
      if (!o || !o.alive || !ra || !rb) continue;
      drawArc(ra, rb, t, 1 - c.stateTime / Math.max(1e-6, c.stateTotal));
    }

    // Outline on top while a wall in front is faded, so the player stays visible.
    if (anyFade) {
      baseZ = pz * LEVEL_Z;
      ellipsePath(pr.pos.x, pr.pos.y, pr.opts.bodyHeight * pr.opts.scale, pr.heading, 0.26 * pr.opts.scale, 0.16 * pr.opts.scale);
      baseZ = 0;
      ctx.globalAlpha = 0.5; ctx.strokeStyle = C.metal4; ctx.lineWidth = px(1); ctx.stroke(); ctx.globalAlpha = 1;
    }

    drawSplats(dt);
    drawRings(dt);
    drawCables((X, Y) => X > camX - halfW && X < camX + halfW && Y > camY - halfH - 40 && Y < camY + halfH + 40);
    for (const [id, tt] of cocoonHits) cocoonHits.set(id, tt + dt);

    for (const q of fx.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, q.life));
      ctx.fillStyle = q.color;
      const sz = px(q.size || 2);
      ctx.fillRect(q.x - sz / 2, q.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    // Rain falls in screen space, before lighting, so it shows near lights.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const storm = rainLevel(state);
    if (look.rain > 0) rain(lw, lh, look.rain, Math.min(dt, 0.05), storm);

    // Colour grade: a light biome tint over everything, eased as you walk, so
    // each region keeps a few flat colours that carry light and distance.
    {
      const pb = biomeAt(Math.max(0, Math.min(map.w - 1, Math.floor(p.x))), Math.max(0, Math.min(map.h - 1, Math.floor(p.y))));
      const want = [[74, 90, 102], [93, 110, 58], [138, 90, 42], [47, 90, 102], [110, 42, 48]][pb];
      const e = Math.min(1, dt * 1.5);
      grade.r += (want[0] - grade.r) * e; grade.g += (want[1] - grade.g) * e; grade.b += (want[2] - grade.b) * e;
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = `rgba(${grade.r | 0},${grade.g | 0},${grade.b | 0},${0.35 + storm * 0.2})`;
      ctx.fillRect(0, 0, lw, lh);
      ctx.globalCompositeOperation = 'source-over';
    }

    // Lighting: darken everything, then cut holes where lights are and add a glow.
    const dark = Math.min(0.9, look.darkness + storm * 0.22);
    if (dark > 0) {
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, lw, lh);
      lctx.fillStyle = `rgba(4,6,8,${dark})`;
      lctx.fillRect(0, 0, lw, lh);
      lctx.globalCompositeOperation = 'destination-out';
      for (const L of lights) {
        const X = L.x * scale + ox, Y = L.y * scale + oy, R = L.r * scale;
        const g = lctx.createRadialGradient(X, Y, 0, X, Y, R);
        g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        lctx.fillStyle = g; lctx.fillRect(X - R, Y - R, R * 2, R * 2);
      }
      ctx.drawImage(light, 0, 0);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const L of lights) {
      const X = L.x * scale + ox, Y = L.y * scale + oy, R = L.r * scale * 0.7;
      const g = ctx.createRadialGradient(X, Y, 0, X, Y, R);
      const [r, gg, b] = [1, 3, 5].map((i) => parseInt(L.color.slice(i, i + 2), 16));
      g.addColorStop(0, `rgba(${r},${gg},${b},${L.glow})`); g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      ctx.fillStyle = g; ctx.fillRect(X - R, Y - R, R * 2, R * 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    // The downpour stays visible over the darkness: a second, brighter veil.
    if (storm > 0.05 && look.rain > 0) {
      ctx.strokeStyle = C.metal4; ctx.lineWidth = 1; ctx.globalAlpha = Math.min(0.6, storm * 0.6);
      ctx.beginPath();
      const slant = 0.25 + storm * 0.35, len = 1 + storm * 3;
      for (let i = 0; i < fx.drops.length; i += 2) {
        const d = fx.drops[i];
        ctx.moveTo(Math.round(d.x), Math.round(d.y)); ctx.lineTo(Math.round(d.x + d.len * len * slant), Math.round(d.y - d.len * len));
      }
      ctx.stroke();
      if (storm >= 0.99) {
        ctx.fillStyle = C.metal3;
        for (const q of fx.sheets) { ctx.globalAlpha = 0.1; ctx.fillRect(Math.round(q.x), 0, Math.round(q.w), lh); }
      }
      ctx.globalAlpha = 1;
    }

    if (look.palette) {
      const img = ctx.getImageData(0, 0, lw, lh);
      quantize(img.data, lw, lh, table, look.dither);
      ctx.putImageData(img, 0, 0);
    }

    out.setTransform(1, 0, 0, 1, 0, 0);
    out.imageSmoothingEnabled = false;
    out.drawImage(low, 0, 0, lw * up, lh * up);
  }

  return {
    resize, draw, burst, hitFx, splat, updateFx, bloodSplatter, bakeHusk, resetDecals, noiseRing, eatFx,
    dust, cocoonBurst, muzzle, webSplat, webTorn, cocoonHit,
    ventPuff: (v) => ventPuff(v, 14),
    renderPreview,
    resetBall: () => { ballSpin.x = null; ballSpin.m = [1, 0, 0, 0, 1, 0, 0, 0, 1]; },
    bigBurst: (x, y) => { burst(x, y); burst(x, y); },
    screenOf: (x, y, z) => ({ x: sx(x, y), y: sy(x, y) - (z ?? lvAt(x, y)) * LEVEL_PX }),
    get size() { return { w, h }; },
  };
}

// Minimap: the arena seen from the same isometric angle, one tile per pixel,
// with shelters, nests, cells and the bug marked.
export function createMinimap(canvas) {
  const g = canvas.getContext('2d');
  const base = document.createElement('canvas');
  let baseMap = null;
  const BIOME_RGB = [[60, 72, 80], [58, 74, 44], [92, 64, 40], [40, 64, 74], [84, 40, 46]];
  function bake(map) {
    base.width = map.w; base.height = map.h;
    const bctx = base.getContext('2d'), img = bctx.createImageData(map.w, map.h);
    for (let i = 0; i < map.w * map.h; i++) {
      const [r, gg, b] = BIOME_RGB[map.biome ? map.biome[i] : 0];
      const k = map.solid[i] ? 0.35 : 1 + map.level[i] * 0.35 + (map.kind[i] ? 0.15 : 0);
      img.data.set([Math.min(255, r * k), Math.min(255, gg * k), Math.min(255, b * k), 255], i * 4);
    }
    bctx.putImageData(img, 0, 0);
    baseMap = map;
  }
  function draw(state, t, storm) {
    const map = state.map;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    if (baseMap !== map) bake(map);
    const k = Math.min(W / (map.w + map.h), (H * 2) / (map.w + map.h));
    const ox = W / 2 - ((map.w - map.h) / 2) * k, oy = H / 2 - ((map.w + map.h) / 4) * k;
    const P = (x, y) => [ox + (x - y) * k, oy + ((x + y) * k) / 2];
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = false;
    g.setTransform(k, k / 2, -k, k / 2, ox, oy);
    g.drawImage(base, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (storm > 0) {
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = `rgba(47,166,200,${storm * 0.25})`; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
    }
    const dot = (x, y, r, color) => { const [X, Y] = P(x, y); g.fillStyle = color; g.fillRect(Math.round(X - r), Math.round(Y - r), r * 2, r * 2); };
    const s = Math.max(1, Math.round(dpr));
    for (const c of state.shards) if (!c.taken) dot(c.x, c.y, s, c.big ? '#b8262a' : '#c8d43c');
    for (const n of state.nests || []) dot(n.x, n.y, s, '#6e7f45');
    for (const h of state.shelters || []) { dot(h.x, h.y, 2 * s, '#0b0d10'); dot(h.x, h.y, s, '#f2c15a'); }
    if (Math.floor(t * 3) % 2 === 0) dot(state.player.x, state.player.y, 2 * s, '#d2fbff');
  }
  return { draw };
}
