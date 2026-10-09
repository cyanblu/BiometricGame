// Canvas renderer. Reads simulation state, never changes it.
import { TILE_W, TILE_H, isSolid } from './sim.js';
import { hipOf, legIK } from './bug.js';

const WALL_H = 34;
const Z_PX = 36; // screen pixels per tile of height
const HW = TILE_W / 2;
const HH = TILE_H / 2;

export function readPalette(el) {
  const cs = getComputedStyle(el);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    sky: v('--night'), sky2: v('--night-2'),
    floor: v('--sand'), floor2: v('--sand-2'), floorEdge: v('--sand-edge'),
    wallTop: v('--slate-top'), wallLeft: v('--slate-left'), wallRight: v('--slate-right'),
    shard: v('--ember'), shardCore: v('--ember-core'),
    body: v('--hull'), hullShade: v('--hull-shade'), limb: v('--limb'),
    visor: v('--visor'), hot: v('--hot'), ink: v('--ink'),
    critters: [[v('--beetle-a'), v('--beetle-a-shade')], [v('--beetle-b'), v('--beetle-b-shade')]],
    critterLimb: v('--beetle-limb'),
  };
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const fx = { particles: [], trail: [] };
  let pal = readPalette(document.documentElement);
  let w = 0, h = 0, dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  // World (tile units) to canvas pixels, before camera transform.
  const sx = (x, y) => (x - y) * HW;
  const sy = (x, y) => (x + y) * HH;

  function diamond(x, y, lift) {
    ctx.beginPath();
    ctx.moveTo(sx(x, y), sy(x, y) - lift);
    ctx.lineTo(sx(x + 1, y), sy(x + 1, y) - lift);
    ctx.lineTo(sx(x + 1, y + 1), sy(x + 1, y + 1) - lift);
    ctx.lineTo(sx(x, y + 1), sy(x, y + 1) - lift);
    ctx.closePath();
  }

  function quad(ax, ay, bx, by, lift) {
    ctx.beginPath();
    ctx.moveTo(sx(ax, ay), sy(ax, ay));
    ctx.lineTo(sx(bx, by), sy(bx, by));
    ctx.lineTo(sx(bx, by), sy(bx, by) - lift);
    ctx.lineTo(sx(ax, ay), sy(ax, ay) - lift);
    ctx.closePath();
  }

  function drawWall(map, tx, ty, alpha = 1) {
    ctx.globalAlpha = alpha;
    // Only the faces pointing at the camera (+x and +y) can be visible.
    if (!isSolid(map, tx, ty + 1) || ty + 1 >= map.h) {
      quad(tx, ty + 1, tx + 1, ty + 1, WALL_H);
      ctx.fillStyle = pal.wallLeft; ctx.fill();
    }
    if (!isSolid(map, tx + 1, ty) || tx + 1 >= map.w) {
      quad(tx + 1, ty, tx + 1, ty + 1, WALL_H);
      ctx.fillStyle = pal.wallRight; ctx.fill();
    }
    diamond(tx, ty, WALL_H);
    ctx.fillStyle = pal.wallTop; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1; ctx.stroke();
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

  function drawShard(s, t) {
    const x = sx(s.x, s.y), y = sy(s.x, s.y);
    const bob = 16 + Math.sin(t * 2.4 + s.x * 1.7 + s.y) * 3;
    const spin = Math.cos(t * 1.8 + s.x);
    ctx.fillStyle = 'rgba(10,12,24,0.25)';
    ctx.beginPath(); ctx.ellipse(x, y, 7, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(x, y - bob);
    ctx.shadowColor = pal.shard; ctx.shadowBlur = 14;
    const gw = 7 * (0.35 + 0.65 * Math.abs(spin));
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(gw, 0); ctx.lineTo(0, 11); ctx.lineTo(-gw, 0);
    ctx.closePath();
    ctx.fillStyle = pal.shard; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(gw * 0.45 * Math.sign(spin || 1), 0); ctx.lineTo(0, 11);
    ctx.closePath();
    ctx.fillStyle = pal.shardCore; ctx.fill();
    ctx.restore();
  }

  // Bug drawing. style: { shell, shade, limb, legW, led (0..1 heat) | null }.
  const P3 = (x, y, z) => [sx(x, y), sy(x, y) - z * Z_PX];

  function ellipsePath(cx, cy, z, heading, a, b) {
    const c = Math.cos(heading), s = Math.sin(heading);
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t = (i / 24) * Math.PI * 2;
      const ex = Math.cos(t) * a, ey = Math.sin(t) * b;
      const [px, py] = P3(cx + ex * c - ey * s, cy + ex * s + ey * c, z);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  function drawLeg(rig, leg, style) {
    const o = rig.opts;
    const hip = hipOf(rig, leg);
    const foot = { x: leg.foot.x, y: leg.foot.y, z: leg.lift };
    const knee = legIK(hip, foot, o.thigh * o.scale, o.shin * o.scale);
    const [hx, hy] = P3(hip.x, hip.y, hip.z);
    const [kx, ky] = P3(knee.x, knee.y, knee.z);
    const [fx2, fy2] = P3(foot.x, foot.y, foot.z);
    ctx.strokeStyle = style.limb; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = style.legW;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(fx2, fy2); ctx.stroke();
    if (style.led != null) {
      ctx.fillStyle = style.shade;
      ctx.beginPath(); ctx.arc(kx, ky, style.legW * 0.7, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawBug(rig, style, alpha = 1) {
    const o = rig.opts, k = o.scale;
    const { x, y } = rig.pos, hd = rig.heading;
    const z = o.bodyHeight * k;
    ctx.save();
    ctx.globalAlpha = alpha;
    // Ground shadow.
    ellipsePath(x, y, 0, hd, 0.3 * k, 0.2 * k);
    ctx.fillStyle = 'rgba(10,12,24,0.28)'; ctx.fill();
    for (const leg of rig.legs) {
      ctx.fillStyle = 'rgba(10,12,24,0.25)';
      const [fx2, fy2] = P3(leg.foot.x, leg.foot.y, 0);
      ctx.beginPath(); ctx.ellipse(fx2, fy2, 2.5 * k + 1, 1.3 * k + 0.6, 0, 0, Math.PI * 2); ctx.fill();
    }
    // Far legs, body, head, near legs.
    const depth = (l) => { const h = hipOf(rig, l); return h.x + h.y; };
    const mid = x + y;
    const legs = [...rig.legs].sort((a, b) => depth(a) - depth(b));
    for (const l of legs) if (depth(l) < mid) drawLeg(rig, l, style);
    ellipsePath(x, y, z - 0.05 * k, hd, 0.27 * k, 0.17 * k);
    ctx.fillStyle = style.shade; ctx.fill();
    ellipsePath(x, y, z, hd, 0.26 * k, 0.16 * k);
    ctx.fillStyle = style.shell; ctx.fill();
    // Wing seam or panel line down the back.
    const c = Math.cos(hd), s = Math.sin(hd);
    const [ax, ay] = P3(x + c * 0.2 * k, y + s * 0.2 * k, z + 0.01);
    const [bx, by] = P3(x - c * 0.24 * k, y - s * 0.24 * k, z + 0.01);
    ctx.strokeStyle = style.shade; ctx.lineWidth = Math.max(1, 1.5 * k);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    if (style.led != null) {
      // Heartbeat light: beats faster and turns hot with core heat.
      const bpm = 60 + style.led * 120;
      const ph = (rig.time * bpm / 60) % 1;
      const pulse = Math.exp(-ph * 9) + 0.6 * Math.exp(-Math.max(0, ph - 0.18) * 12) * (ph > 0.18 ? 1 : 0);
      const [lx, ly] = P3(x - c * 0.12 * k, y - s * 0.12 * k, z + 0.02);
      ctx.fillStyle = style.led > 0.5 ? pal.hot : pal.visor;
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 6 + 10 * pulse;
      ctx.globalAlpha = alpha * (0.45 + 0.55 * Math.min(1, pulse));
      ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = alpha;
    }
    // Head lags behind the body (its own, slower follower).
    const hx = rig.headPos.x, hy = rig.headPos.y;
    ellipsePath(hx, hy, z + 0.02 * k, hd, 0.11 * k, 0.1 * k);
    ctx.fillStyle = style.shade; ctx.fill();
    ellipsePath(hx, hy, z + 0.05 * k, hd, 0.1 * k, 0.09 * k);
    ctx.fillStyle = style.shell; ctx.fill();
    if (style.led != null) {
      ellipsePath(hx + c * 0.06 * k, hy + s * 0.06 * k, z + 0.07 * k, hd, 0.045 * k, 0.07 * k);
      ctx.fillStyle = pal.visor; ctx.fill();
    }
    // Antennae.
    ctx.strokeStyle = style.limb; ctx.lineWidth = Math.max(1, 1.2 * k);
    for (const side of [-1, 1]) {
      const [rx, ry] = P3(hx + c * 0.07 * k - s * side * 0.04 * k, hy + s * 0.07 * k + c * side * 0.04 * k, z + 0.07 * k);
      const tx = hx + c * 0.24 * k - s * side * 0.13 * k, ty = hy + s * 0.24 * k + c * side * 0.13 * k;
      const [qx, qy] = P3(tx, ty, z + 0.2 * k);
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(qx, qy); ctx.stroke();
    }
    for (const l of legs) if (depth(l) >= mid) drawLeg(rig, l, style);
    ctx.restore();
  }

  function playerStyle(heat) {
    return { shell: pal.body, shade: pal.hullShade, limb: pal.limb, legW: 3, led: heat };
  }
  function critterStyle(i) {
    const [shell, shade] = pal.critters[i % pal.critters.length];
    return { shell, shade, limb: pal.critterLimb, legW: 1.6, led: null };
  }

  function burst(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      fx.particles.push({ x: sx(x, y), y: sy(x, y) - 16, vx: Math.cos(a) * 90, vy: Math.sin(a) * 60 - 40, life: 1 });
    }
  }

  function updateFx(dt, p, px, py) {
    for (const q of fx.particles) {
      q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 160 * dt; q.life -= dt * 1.8;
    }
    fx.particles = fx.particles.filter((q) => q.life > 0);
    for (const g of fx.trail) g.life -= dt * 4;
    fx.trail = fx.trail.filter((g) => g.life > 0);
    if (p.dashTime > 0) fx.trail.push({ x: px, y: py, life: 1 });
  }

  function draw(state, view, rigs, t) {
    const { map } = state;
    const p = state.player;
    const px = p.px + (p.x - p.px) * view.alpha;
    const py = p.py + (p.y - p.py) * view.alpha;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, pal.sky2); g.addColorStop(1, pal.sky);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const z = view.zoom * dpr;
    ctx.setTransform(z, 0, 0, z, canvas.width / 2 - view.camX * z, canvas.height / 2 - view.camY * z);

    // Ground slab edge, so the level reads as a floating diorama.
    ctx.fillStyle = pal.floorEdge;
    ctx.beginPath();
    ctx.moveTo(sx(0, map.h), sy(0, map.h));
    ctx.lineTo(sx(map.w, map.h), sy(map.w, map.h));
    ctx.lineTo(sx(map.w, 0), sy(map.w, 0));
    ctx.lineTo(sx(map.w, 0), sy(map.w, 0) + 18);
    ctx.lineTo(sx(map.w, map.h), sy(map.w, map.h) + 18);
    ctx.lineTo(sx(0, map.h), sy(0, map.h) + 18);
    ctx.closePath(); ctx.fill();

    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        if (isSolid(map, tx, ty)) continue;
        diamond(tx, ty, 0);
        ctx.fillStyle = (tx + ty) % 2 ? pal.floor : pal.floor2;
        ctx.fill();
      }
    }

    // Painter's order by x + y. Walls use their centre, entities their feet.
    const items = [];
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        if (isSolid(map, tx, ty)) items.push({ d: tx + ty + 1, k: 0, tx, ty });
      }
    }
    for (const s of state.shards) if (!s.taken) items.push({ d: s.x + s.y, k: 1, s });
    rigs.critters.forEach((rig, i) => items.push({ d: rig.pos.x + rig.pos.y, k: 3, rig, i }));
    items.push({ d: rigs.player.pos.x + rigs.player.pos.y, k: 2 });
    items.sort((a, b) => a.d - b.d || a.k - b.k);

    for (const it of items) {
      if (it.k === 0) {
        const front = it.d > rigs.player.pos.x + rigs.player.pos.y;
        drawWall(map, it.tx, it.ty, front && hidesPlayer(it.tx, it.ty, rigs.player) ? 0.35 : 1);
      }
      else if (it.k === 1) drawShard(it.s, t);
      else if (it.k === 3) drawBug(it.rig, critterStyle(it.i));
      else {
        const pr = rigs.player, z = pr.opts.bodyHeight * pr.opts.scale;
        for (const g of fx.trail) {
          ellipsePath(g.x, g.y, z, pr.heading, 0.26, 0.16);
          ctx.fillStyle = pal.visor; ctx.globalAlpha = g.life * 0.3; ctx.fill(); ctx.globalAlpha = 1;
        }
        drawBug(pr, playerStyle(p.heat));
      }
    }

    // Outline on top so the player stays visible behind walls.
    const pr = rigs.player;
    ellipsePath(pr.pos.x, pr.pos.y, pr.opts.bodyHeight * pr.opts.scale, pr.heading, 0.26, 0.16);
    ctx.strokeStyle = pal.ink; ctx.globalAlpha = 0.3; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;

    for (const q of fx.particles) {
      ctx.globalAlpha = Math.max(0, q.life);
      ctx.fillStyle = pal.shard;
      ctx.fillRect(q.x - 2, q.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
    return { px, py };
  }

  return {
    resize, draw, burst, updateFx,
    screenOf: (x, y) => ({ x: sx(x, y), y: sy(x, y) }),
    get size() { return { w, h }; },
  };
}
