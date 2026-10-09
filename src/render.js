// Canvas renderer. Reads simulation state, never changes it.
// The world is drawn into a small offscreen canvas (one pixel per `look.pixel`
// screen pixels), lit, snapped to the palette in src/pixel.js, then scaled up
// without smoothing: a pixelated viewport over a grimy, wet, electrical world.
import { TILE_W, TILE_H, isSolid } from './sim.js';
import { hipOf, legIK } from './bug.js';
import { COLORS, buildLut, quantize } from './pixel.js';

const C = COLORS;
const WALL_H = 34;
const Z_PX = 36; // world pixels per tile of height
const HW = TILE_W / 2;
const HH = TILE_H / 2;

export const LOOK_DEFAULTS = { pixel: 3, dither: 6, darkness: 0.55, rain: 0.6, palette: true };

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
  function drawCell(s, t) {
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
    if (style.led != null) {
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
      ctx.fillStyle = C.elec1; ctx.fill();
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

  const CRITTER_STYLES = [
    { shell: C.beetleA1, shade: C.beetleA0, limb: C.limb, legW: 1.6, led: null },
    { shell: C.beetleB1, shade: C.beetleB0, limb: C.limb, legW: 1.6, led: null },
  ];

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
    const ps = Math.max(1, Math.round(look.pixel));
    const lw = Math.max(1, Math.ceil(w / ps)), lh = Math.max(1, Math.ceil(h / ps));
    if (low.width !== lw || low.height !== lh) {
      low.width = lw; low.height = lh; light.width = lw; light.height = lh;
    }
    lights = [];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = C.void0; ctx.fillRect(0, 0, lw, lh);

    scale = view.zoom / ps;
    onePx = 1 / scale;
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
    rigs.critters.forEach((rig, i) => items.push({ d: rig.pos.x + rig.pos.y, k: 3, rig, i }));
    const pd = pr.pos.x + pr.pos.y;
    items.push({ d: pd, k: 2 });
    items.sort((a, b) => a.d - b.d || a.k - b.k);

    for (const it of items) {
      if (it.k === 0) drawWall(map, it.tx, it.ty, t, it.d > pd && hidesPlayer(it.tx, it.ty, pr) ? 0.35 : 1);
      else if (it.k === 1) drawCell(it.s, t);
      else if (it.k === 3) drawBug(it.rig, CRITTER_STYLES[it.i % CRITTER_STYLES.length], t);
      else {
        drawBug(pr, {
          shell: C.hull1, shade: C.hull0, limb: C.limb, legW: 3, led: p.heat, overheated: p.overheated,
        }, t);
      }
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
    out.drawImage(low, 0, 0, lw * ps * dpr, lh * ps * dpr);
  }

  return {
    resize, draw, burst, updateFx,
    screenOf: (x, y) => ({ x: sx(x, y), y: sy(x, y) }),
    get size() { return { w, h }; },
  };
}
