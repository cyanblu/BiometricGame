// Canvas renderer. Reads simulation state, never changes it.
// The world is drawn into a small offscreen canvas at a fixed art resolution
// (one art pixel = `look.pixel` world pixels, whatever the zoom), lit, snapped
// to the palette in src/pixel.js, then scaled up by a whole number without
// smoothing. Zoom only changes that whole-number scale, never the art.
import { TILE_W, TILE_H, isSolid, groundLevel, tileLevelAt } from './sim.js';
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
  const fx = { particles: [], trail: [], drops: [] };
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
  function drawDeck(tx, ty, level) {
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

  // ---- terrain columns -------------------------------------------------------
  // Earth/concrete cliff faces under raised floors and slopes.
  function decorateCliff(face) {
    const { tx, ty } = face, k = face.side === 'y' ? 200 : 250;
    // Strata line and grime at the foot.
    ctx.strokeStyle = C.conc0; ctx.lineWidth = px(1);
    ctx.beginPath(); ctx.moveTo(...facePoint(face, 0, 0.5)); ctx.lineTo(...facePoint(face, 1, 0.5)); ctx.stroke();
    faceQuad(face, 0, 1, 0, 0.18); ctx.fillStyle = C.grime; ctx.fill();
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
      faceQuad(f, 0, 1, 0, 1);
      ctx.fillStyle = f.side === 'y' ? C.conc0 : C.void2; ctx.fill();
      decorateCliff(f);
    }
    const base = map.level[i] * LEVEL_PX;
    if (map.kind[i] === 1) drawRamp(tx, ty, map.sdx[i], map.sdy[i], base);
    else if (map.kind[i] === 2) drawStairs(tx, ty, map.sdx[i], map.sdy[i], base);
    else {
      ctx.save(); ctx.translate(0, -base);
      drawDeck(tx, ty, map.level[i]);
      // Worn bright lip along the front edges, so the drop reads.
      ctx.strokeStyle = C.metal4; ctx.lineWidth = px(2);
      ctx.beginPath();
      ctx.moveTo(sx(tx, ty + 1), sy(tx, ty + 1)); ctx.lineTo(sx(tx + 1, ty + 1), sy(tx + 1, ty + 1)); ctx.lineTo(sx(tx + 1, ty), sy(tx + 1, ty));
      ctx.stroke();
      ctx.restore();
      drawTileBlood(tx, ty, base, true);
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

  function wallTop(tx, ty) { return map.level[ty * map.w + tx] * LEVEL_PX + WALL_H; }

  function drawWall(tx, ty, t, alpha = 1) {
    ctx.globalAlpha = alpha;
    const top = wallTop(tx, ty);
    for (const f of columnFaces(tx, ty, () => top)) {
      faceQuad(f, 0, 1, 0, 1);
      ctx.fillStyle = f.side === 'y' ? C.metal1 : C.metal0; ctx.fill();
      decorateFace(f, t);
    }
    const WALL_H = top; // lift of the top face (shadows the module constant)
    diamond(tx, ty, WALL_H);
    ctx.fillStyle = C.metal3; ctx.fill();
    diamond(tx, ty, WALL_H, 0.12);
    ctx.strokeStyle = C.metal2; ctx.lineWidth = px(1); ctx.stroke();
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
    ctx.fillStyle = C.void1;
    ctx.beginPath(); ctx.ellipse(X, Y, 12, 6, 0, 0, Math.PI * 2); ctx.fill();
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
    ctx.fillStyle = C.void1;
    ctx.beginPath(); ctx.ellipse(X, Y, 7, 3.5, 0, 0, Math.PI * 2); ctx.fill();
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
    // Feet stand on whatever ground is under them (steps, ramps).
    const footGround = (lvAt(leg.foot.x, leg.foot.y) - lvAt(rig.pos.x, rig.pos.y)) * LEVEL_Z;
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

  function drawBug(rig, style, t) {
    baseZ = lvAt(rig.pos.x, rig.pos.y) * LEVEL_Z;
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
    const z = o.bodyHeight * k;
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
    ellipsePath(x, y, 0, hd, (kind === 'harvestman' ? 0.16 : 0.3) * k, (kind === 'harvestman' ? 0.14 : 0.2) * k);
    ctx.fillStyle = C.void1; ctx.fill();
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
  function drawBall(b, radius) {
    spinBall(b, radius);
    const X = sx(b.x, b.y), base = sy(b.x, b.y) - liftAt(b.x, b.y);
    const R = radius * Math.SQRT2 * HW;
    const Y = base - R * 0.9;
    ctx.fillStyle = C.void1;
    ctx.beginPath(); ctx.ellipse(X, base, R * 1.05, R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
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
    ctx = pc; lights = []; map = null; baseZ = 0;
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
  }


  const SPIDER_SHELLS = [[C.beetleB1, C.beetleB0], [C.beetleA1, C.beetleA0]];

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
    baseZ = lvAt(rig.pos.x, rig.pos.y) * LEVEL_Z;
    drawSpiderAt(rig, c, i, t);
    baseZ = 0;
  }

  function drawSpiderAt(rig, c, i, t) {
    const o = rig.opts, k = o.scale, hd = rig.heading;
    const cs = Math.cos(hd), sn = Math.sin(hd);
    const { x, y } = rig.pos;
    const dead = !c.alive;
    const [shell, shade] = dead ? [C.void2, C.void1] : SPIDER_SHELLS[i % SPIDER_SHELLS.length];
    const z = dead ? 0.04 : o.bodyHeight * k;
    ellipsePath(x, y, 0, hd, 0.32 * k, 0.26 * k);
    ctx.fillStyle = C.void1; ctx.fill();
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
    ctx.fillStyle = dead ? C.void1 : C.rust2; ctx.fill();
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

  // Jagged electric arc between two spiders; brighter as the wind-up completes.
  function drawArc(ra, rb, t, charge) {
    const za = ra.opts.bodyHeight * ra.opts.scale + lvAt(ra.pos.x, ra.pos.y) * LEVEL_Z;
    const zb = rb.opts.bodyHeight * rb.opts.scale + lvAt(rb.pos.x, rb.pos.y) * LEVEL_Z;
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
        const [X, Y] = P3(rig.pos.x, rig.pos.y, rig.opts.bodyHeight + lvAt(rig.pos.x, rig.pos.y) * LEVEL_Z);
        const steam = Math.random() < 0.6;
        fx.particles.push(steam
          ? { x: X + (Math.random() - 0.5) * 12, y: Y - 4, vx: (Math.random() - 0.5) * 10, vy: -25, life: 1, fade: 1.2, grav: -10, color: C.metal4, size: 3 }
          : { x: X, y: Y, vx: (Math.random() - 0.5) * 120, vy: -60 - Math.random() * 60, life: 1, fade: 3, grav: 300, color: Math.random() < 0.5 ? C.elec2 : C.hot1 });
      }
    }
  }

  function rain(lw, lh, amount, dt) {
    const want = Math.round(amount * (lw * lh) / 900);
    while (fx.drops.length < want) {
      fx.drops.push({ x: Math.random() * (lw + 40), y: Math.random() * lh, v: 160 + Math.random() * 120, len: 2 + Math.random() * 3 });
    }
    fx.drops.length = Math.min(fx.drops.length, want);
    ctx.strokeStyle = C.metal3; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of fx.drops) {
      d.y += d.v * dt; d.x -= d.v * 0.25 * dt;
      if (d.y > lh || d.x < -4) { d.y = -5; d.x = Math.random() * (lw + 40); }
      ctx.moveTo(Math.round(d.x), Math.round(d.y));
      ctx.lineTo(Math.round(d.x + d.len * 0.25), Math.round(d.y - d.len));
    }
    ctx.stroke();
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

    // Ground level: flat level-0 floor first, with its blood and vents.
    const ground = (tx, ty) => { const i = ty * map.w + tx; return !map.solid[i] && !map.kind[i] && map.level[i] === 0; };
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) if (ground(tx, ty)) drawFloor(tx, ty, t);
    }
    if (decal.map === map) {
      for (const key of decal.tiles.keys()) {
        const tx = key % map.w, ty = Math.floor(key / map.w);
        if (ground(tx, ty)) drawTileBlood(tx, ty, 0, false);
      }
    }
    for (const v of state.vents) if (ground(Math.floor(v.x), Math.floor(v.y))) drawVent(v, t, dt);

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
      for (let tx = 0; tx < map.w; tx++) if (!ground(tx, ty)) items.push({ d: tx + ty + 1, k: 0, tx, ty, top: colTop(tx, ty) });
    }
    for (const v of state.vents) {
      const tx = Math.floor(v.x), ty = Math.floor(v.y);
      if (!ground(tx, ty)) items.push({ d: tx + ty + 1, k: 0.5, v });
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
    for (const c of state.critters) {
      const rig = rigs.critters.get(c.id);
      if (rig) items.push({ d: standDepth(rig.pos.x, rig.pos.y) - (c.alive ? 0 : 0.01), k: 3, rig, i: c.id, c });
    }
    if (p.ball) items.push({ d: standDepth(p.ball.x, p.ball.y), k: 1.5, b: p.ball });
    const pd = standDepth(pr.pos.x, pr.pos.y);
    const pz = lvAt(pr.pos.x, pr.pos.y);
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
      else if (it.k === 1) drawCell(it.s, t);
      else if (it.k === 1.5) drawBall(it.b, rigs.ballRadius || 0.32);
      else if (it.k === 3) drawSpider(it.rig, it.c, it.i, t);
      else {
        const empty = p.charges <= 0;
        drawBug(pr, {
          kind: rigs.kind,
          shell: empty ? C.hull0 : C.hull1, shade: empty ? C.metal1 : C.hull0, limb: C.limb,
          legW: 3, led: p.heat, overheated: p.overheated, empty,
        }, t);
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

    for (const q of fx.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, q.life));
      ctx.fillStyle = q.color;
      const sz = px(q.size || 2);
      ctx.fillRect(q.x - sz / 2, q.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    // Rain falls in screen space, before lighting, so it shows near lights.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (look.rain > 0) rain(lw, lh, look.rain, Math.min(dt, 0.05));

    // Lighting: darken everything, then cut holes where lights are and add a glow.
    if (look.darkness > 0) {
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, lw, lh);
      lctx.fillStyle = `rgba(4,6,8,${look.darkness})`;
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
    resize, draw, burst, hitFx, splat, updateFx, bloodSplatter, bakeHusk, resetDecals,
    ventPuff: (v) => ventPuff(v, 14),
    renderPreview,
    resetBall: () => { ballSpin.x = null; ballSpin.m = [1, 0, 0, 0, 1, 0, 0, 0, 1]; },
    bigBurst: (x, y) => { burst(x, y); burst(x, y); },
    screenOf: (x, y) => ({ x: sx(x, y), y: sy(x, y) - liftAt(x, y) }),
    get size() { return { w, h }; },
  };
}
