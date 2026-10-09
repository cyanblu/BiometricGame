// Canvas renderer. Reads simulation state, never changes it.
// The world is drawn into a small offscreen canvas at a fixed art resolution
// (one art pixel = `look.pixel` world pixels, whatever the zoom), lit, snapped
// to the palette in src/pixel.js, then scaled up by a whole number without
// smoothing. Zoom only changes that whole-number scale, never the art.
import { TILE_W, TILE_H, isSolid } from './sim.js';
import { hipOf, legIK } from './bug.js';
import { COLORS, buildLut, quantize } from './pixel.js';

const C = COLORS;
const WALL_H = 34;
const Z_PX = 36; // world pixels per tile of height
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
  const ctx = low.getContext('2d', { willReadFrequently: true });
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
  const P3 = (x, y, z) => [sx(x, y), sy(x, y) - z * Z_PX];
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

  // Point on a wall face: u along the bottom edge (0..1), v up the face (0..1).
  function facePoint(face, u, v) {
    const [x, y] = face.side === 'y' ? [face.tx + u, face.ty + 1] : [face.tx + 1, face.ty + u];
    return [sx(x, y), sy(x, y) - v * WALL_H];
  }
  function faceQuad(face, u0, u1, v0, v1) {
    const a = facePoint(face, u0, v0), b = facePoint(face, u1, v0);
    const c = facePoint(face, u1, v1), d = facePoint(face, u0, v1);
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.lineTo(...d); ctx.closePath();
  }

  // ---- floor ---------------------------------------------------------------
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

  function drawWall(map, tx, ty, t, alpha = 1) {
    ctx.globalAlpha = alpha;
    const faces = [];
    if (!isSolid(map, tx, ty + 1) || ty + 1 >= map.h) faces.push({ side: 'y', tx, ty, color: C.metal1 });
    if (!isSolid(map, tx + 1, ty) || tx + 1 >= map.w) faces.push({ side: 'x', tx, ty, color: C.metal0 });
    for (const f of faces) {
      faceQuad(f, 0, 1, 0, 1);
      ctx.fillStyle = f.color; ctx.fill();
      decorateFace(f, t);
    }
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

  // True when a wall drawn after the player would cover its sprite.
  function hidesPlayer(tx, ty, pr) {
    const cx = sx(pr.pos.x, pr.pos.y), cy = sy(pr.pos.x, pr.pos.y) - 10;
    const left = (tx - ty - 1) * HW, right = (tx - ty + 1) * HW;
    const top = sy(tx, ty) - WALL_H, bottom = sy(tx + 1, ty + 1);
    const R = 26;
    return cx + R > left && cx - R < right && cy + R > top && cy - R < bottom;
  }

  // ---- batteries -----------------------------------------------------------
  // Big red battery: worth three small cells, and looks it.
  function drawBigCell(s, t) {
    const X = sx(s.x, s.y), Y = sy(s.x, s.y);
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
    const X = sx(s.x, s.y), Y = sy(s.x, s.y);
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
    const foot = { x: leg.foot.x, y: leg.foot.y, z: leg.lift };
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
    const o = rig.opts, k = o.scale;
    const { x, y } = rig.pos, hd = rig.heading;
    const z = o.bodyHeight * k;
    ellipsePath(x, y, 0, hd, 0.3 * k, 0.2 * k);
    ctx.fillStyle = C.void1; ctx.fill();
    const depth = (l) => { const hp = hipOf(rig, l); return hp.x + hp.y; };
    const mid = x + y;
    const legs = [...rig.legs].sort((a, b) => depth(a) - depth(b));
    for (const l of legs) if (depth(l) < mid) drawLeg(rig, l, style);
    ellipsePath(x, y, z - 0.05 * k, hd, 0.27 * k, 0.17 * k);
    ctx.fillStyle = style.shade; ctx.fill();
    ellipsePath(x, y, z, hd, 0.26 * k, 0.16 * k);
    ctx.fillStyle = style.shell; ctx.fill();
    const c = Math.cos(hd), s = Math.sin(hd);
    ctx.strokeStyle = style.shade; ctx.lineWidth = px(1.5 * k);
    ctx.beginPath();
    ctx.moveTo(...P3(x + c * 0.2 * k, y + s * 0.2 * k, z + 0.01));
    ctx.lineTo(...P3(x - c * 0.24 * k, y - s * 0.24 * k, z + 0.01));
    ctx.stroke();
    if (style.led != null && style.empty) {
      // Out of charges: the light is dead, not blinking.
      const [lx, ly] = P3(x - c * 0.12 * k, y - s * 0.12 * k, z + 0.02);
      ctx.fillStyle = C.void2;
      ctx.beginPath(); ctx.arc(lx, ly, px(3), 0, Math.PI * 2); ctx.fill();
    } else if (style.led != null) {
      // Heartbeat light: faster and hotter with core heat; stutters when overheated.
      const bpm = 60 + style.led * 120;
      const ph = (rig.time * bpm / 60) % 1;
      let on = ph < 0.12 || (ph > 0.2 && ph < 0.3);
      if (style.overheated) on = hash(Math.floor(t * 20), 1) > 0.4;
      const [lx, ly] = P3(x - c * 0.12 * k, y - s * 0.12 * k, z + 0.02);
      const hot = style.led > 0.5 || style.overheated;
      ctx.fillStyle = on ? (hot ? C.hot1 : C.elec1) : (hot ? C.hot0 : C.elec0);
      ctx.beginPath(); ctx.arc(lx, ly, px(3), 0, Math.PI * 2); ctx.fill();
      if (on) lights.push({ x: lx, y: ly, r: 34, color: hot ? C.hot1 : C.elec1, glow: 0.35 });
    }
    const hx = rig.headPos.x, hy = rig.headPos.y;
    ellipsePath(hx, hy, z + 0.02 * k, hd, 0.11 * k, 0.1 * k);
    ctx.fillStyle = style.shade; ctx.fill();
    ellipsePath(hx, hy, z + 0.05 * k, hd, 0.1 * k, 0.09 * k);
    ctx.fillStyle = style.shell; ctx.fill();
    if (style.led != null) {
      ellipsePath(hx + c * 0.06 * k, hy + s * 0.06 * k, z + 0.07 * k, hd, 0.045 * k, 0.07 * k);
      ctx.fillStyle = style.empty ? C.void2 : C.elec1; ctx.fill();
    }
    if (style.led != null && !style.empty) {
      // Head lamp: a soft pool of light ahead of the bug.
      const [ex, ey] = P3(hx + c * 0.6, hy + s * 0.6, 0);
      lights.push({ x: ex, y: ey, r: 85, color: C.elec1, glow: 0.08 });
      // A faint glow on the bug itself, so it never vanishes in the dark.
      const [bx, by] = P3(x, y, z);
      lights.push({ x: bx, y: by, r: 55, color: C.elec1, glow: 0.12 });
    }
    ctx.strokeStyle = style.limb; ctx.lineWidth = px(1.2 * k);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(...P3(hx + c * 0.07 * k - s * side * 0.04 * k, hy + s * 0.07 * k + c * side * 0.04 * k, z + 0.07 * k));
      ctx.lineTo(...P3(hx + c * 0.24 * k - s * side * 0.13 * k, hy + s * 0.24 * k + c * side * 0.13 * k, z + 0.2 * k));
      ctx.stroke();
    }
    for (const l of legs) if (depth(l) >= mid) drawLeg(rig, l, style);
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
    const za = ra.opts.bodyHeight * ra.opts.scale, zb = rb.opts.bodyHeight * rb.opts.scale;
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
    // Something red breathes down there.
    const glow = 0.5 + 0.5 * Math.sin(t * 1.7 + v.x);
    lights.push({ x: sx(v.x, v.y), y: sy(v.x, v.y), r: 34, color: C.blood2, glow: 0.12 + glow * 0.12 });
    if (Math.random() < dt * 1.5) ventPuff(v, 1);
  }

  function ventPuff(v, n = 10) {
    const X = sx(v.x, v.y), Y = sy(v.x, v.y);
    for (let i = 0; i < n; i++) {
      fx.particles.push({
        x: X + (Math.random() - 0.5) * 24, y: Y - 2, vx: (Math.random() - 0.5) * 20, vy: -20 - Math.random() * 25,
        life: 1, fade: 0.9 + Math.random() * 0.6, grav: -8, color: i % 3 ? C.metal3 : C.metal4, size: 3,
      });
    }
  }

  // ---- blood layer ---------------------------------------------------------
  // World-pixel canvas under everything that stands on the floor. Splatters
  // are generated once, when the kill happens, and stay for the run.
  const decal = { canvas: null, ctx: null, map: null, x0: 0, y0: 0, w: 0, h: 0, k: 0.5 };

  function resetDecals(map) {
    decal.map = map;
    decal.x0 = -map.h * HW; decal.y0 = -HH;
    decal.w = (map.w + map.h) * HW; decal.h = (map.w + map.h) * HH + HH * 2;
    decal.canvas = document.createElement('canvas');
    decal.canvas.width = Math.ceil(decal.w * decal.k);
    decal.canvas.height = Math.ceil(decal.h * decal.k);
    decal.ctx = decal.canvas.getContext('2d');
    decal.ctx.setTransform(decal.k, 0, 0, decal.k, -decal.x0 * decal.k, -decal.y0 * decal.k);
  }

  // A circle of radius r tiles lying on the floor.
  function floorDot(g, x, y, r, color) {
    g.fillStyle = color;
    g.beginPath(); g.ellipse(sx(x, y), sy(x, y), r * Math.SQRT2 * HW, r * Math.SQRT2 * HH, 0, 0, Math.PI * 2); g.fill();
  }

  function bloodSplatter(map, x, y, dirX, dirY) {
    if (decal.map !== map) resetDecals(map);
    const g = decal.ctx;
    const open = (px2, py2) => !isSolid(map, Math.floor(px2), Math.floor(py2));
    const rnd = Math.random;
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    const aim = Math.hypot(dirX, dirY) > 0.1 ? Math.atan2(dirY, dirX) : rnd() * Math.PI * 2;
    // Pool where it died.
    for (let i = 0; i < 5; i++) {
      const px2 = x + gauss() * 0.12, py2 = y + gauss() * 0.12;
      if (open(px2, py2)) floorDot(g, px2, py2, 0.08 + rnd() * 0.14, i < 2 ? C.blood0 : C.blood1);
    }
    // Streaks thrown along the dash.
    g.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = aim + gauss() * 0.35, len = 0.3 + rnd() * 0.8;
      const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
      if (!open(ex, ey)) continue;
      g.strokeStyle = rnd() < 0.3 ? C.blood2 : C.blood1;
      g.lineWidth = 2 + rnd() * 3;
      g.beginPath(); g.moveTo(sx(x, y), sy(x, y)); g.lineTo(sx(ex, ey), sy(ex, ey)); g.stroke();
    }
    // Droplets: most land close, a few fly far; smaller the further they go.
    // Sized so even small drops survive the pixel filter (>= ~1 art pixel).
    const n = 22 + Math.floor(rnd() * 14);
    for (let i = 0; i < n; i++) {
      const a = aim + gauss() * 0.9;
      const d = Math.min(2.4, 0.2 - Math.log(1 - rnd() * 0.98) * 0.55);
      const px2 = x + Math.cos(a) * d, py2 = y + Math.sin(a) * d;
      if (!open(px2, py2)) continue;
      const r = Math.max(0.03, 0.09 - d * 0.03) * (0.6 + rnd() * 0.8);
      floorDot(g, px2, py2, r, rnd() < 0.25 ? C.blood2 : C.blood1);
    }
  }

  // When a corpse leaves the simulation, its dried husk stays on the floor.
  function bakeHusk(map, x, y) {
    if (decal.map !== map) resetDecals(map);
    const g = decal.ctx, hd = Math.random() * Math.PI * 2;
    floorDot(g, x - Math.cos(hd) * 0.06, y - Math.sin(hd) * 0.06, 0.11, C.void2);
    floorDot(g, x + Math.cos(hd) * 0.06, y + Math.sin(hd) * 0.06, 0.06, C.void1);
    g.strokeStyle = C.void1; g.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      const a = hd + (i / 8) * Math.PI * 2 + 0.2;
      const mx = x + Math.cos(a) * 0.14, my = y + Math.sin(a) * 0.14;
      const ex = x + Math.cos(a + 0.5) * 0.1, ey = y + Math.sin(a + 0.5) * 0.1;
      g.beginPath(); g.moveTo(sx(x, y), sy(x, y)); g.quadraticCurveTo(sx(mx, my), sy(mx, my), sx(ex, ey), sy(ex, ey)); g.stroke();
    }
  }

  // ---- particles & weather --------------------------------------------------
  function burst(x, y) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      fx.particles.push({
        x: sx(x, y), y: sy(x, y) - 10, vx: Math.cos(a) * 80, vy: Math.sin(a) * 50 - 50,
        life: 1, fade: 2, grav: 200, color: i % 3 ? C.cell2 : C.elec2,
      });
    }
  }

  function hitFx(x, y) {
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      fx.particles.push({
        x: sx(x, y), y: sy(x, y) - 8, vx: Math.cos(a) * 110, vy: Math.sin(a) * 70 - 40,
        life: 1, fade: 2.5, grav: 260, color: i % 2 ? C.hot1 : C.bone,
      });
    }
  }

  function splat(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      fx.particles.push({
        x: sx(x, y), y: sy(x, y) - 6, vx: Math.cos(a) * 60, vy: Math.sin(a) * 40 - 30,
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
        const [X, Y] = P3(rig.pos.x, rig.pos.y, rig.opts.bodyHeight);
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
    const { map } = state;
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

    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) if (!isSolid(map, tx, ty)) drawFloor(tx, ty, t);
    }
    for (const v of state.vents) drawVent(v, t, dt);
    // Blood and husks, baked into their own layer as they happen.
    if (decal.canvas && decal.map === map) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(decal.canvas, decal.x0, decal.y0, decal.w, decal.h);
    }

    // Dash afterimage on the floor.
    const pr = rigs.player;
    for (const g of fx.trail) {
      ellipsePath(g.x, g.y, pr.opts.bodyHeight, pr.heading, 0.26, 0.16);
      ctx.globalAlpha = g.life * 0.5; ctx.fillStyle = C.elec0; ctx.fill(); ctx.globalAlpha = 1;
    }

    // Painter's order by x + y. Walls use their centre, entities their feet.
    const items = [];
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) if (isSolid(map, tx, ty)) items.push({ d: tx + ty + 1, k: 0, tx, ty });
    }
    for (const s of state.shards) if (!s.taken) items.push({ d: s.x + s.y, k: 1, s });
    for (const c of state.critters) {
      const rig = rigs.critters.get(c.id);
      if (rig) items.push({ d: rig.pos.x + rig.pos.y - (c.alive ? 0 : 0.5), k: 3, rig, i: c.id, c });
    }
    const pd = pr.pos.x + pr.pos.y;
    items.push({ d: pd, k: 2 });
    items.sort((a, b) => a.d - b.d || a.k - b.k);

    for (const it of items) {
      if (it.k === 0) drawWall(map, it.tx, it.ty, t, it.d > pd && hidesPlayer(it.tx, it.ty, pr) ? 0.35 : 1);
      else if (it.k === 1) drawCell(it.s, t);
      else if (it.k === 3) drawSpider(it.rig, it.c, it.i, t);
      else {
        const empty = p.charges <= 0;
        drawBug(pr, {
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

    // Outline on top so the player stays visible behind walls.
    ellipsePath(pr.pos.x, pr.pos.y, pr.opts.bodyHeight, pr.heading, 0.26, 0.16);
    ctx.globalAlpha = 0.5; ctx.strokeStyle = C.metal4; ctx.lineWidth = px(1); ctx.stroke(); ctx.globalAlpha = 1;

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
    bigBurst: (x, y) => { burst(x, y); burst(x, y); },
    screenOf: (x, y) => ({ x: sx(x, y), y: sy(x, y) }),
    get size() { return { w, h }; },
  };
}
