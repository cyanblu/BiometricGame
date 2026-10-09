// Canvas renderer. Reads simulation state, never changes it.
import { TILE_W, TILE_H, isSolid } from './sim.js';

const WALL_H = 34;
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
    body: v('--hull'), visor: v('--visor'), ink: v('--ink'),
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

  function drawWall(map, tx, ty) {
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

  function playerShape(x, y, p, alpha, outlineOnly) {
    const bodyW = 11, bodyH = 26;
    const top = y - bodyH;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(x - bodyW, y - 6);
    ctx.lineTo(x - bodyW, top + bodyW);
    ctx.arc(x, top + bodyW, bodyW, Math.PI, 0);
    ctx.lineTo(x + bodyW, y - 6);
    ctx.ellipse(x, y - 6, bodyW, bodyW * 0.5, 0, 0, Math.PI);
    ctx.closePath();
    if (outlineOnly) {
      ctx.strokeStyle = pal.ink; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.fillStyle = pal.body; ctx.fill();
      // Visor faces the movement direction, squashed by the projection.
      const fx2 = sx(p.faceX, p.faceY), fy2 = sy(p.faceX, p.faceY);
      const fl = Math.hypot(fx2, fy2) || 1;
      const vx = (fx2 / fl) * bodyW * 0.55;
      const front = fy2 > -0.2;
      if (front) {
        ctx.beginPath();
        ctx.ellipse(x + vx, top + bodyW + 1, 6.5, 3.6, 0, 0, Math.PI * 2);
        ctx.fillStyle = pal.visor; ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawPlayer(x, y, p, params) {
    const r = params.radius * Math.SQRT2;
    ctx.fillStyle = 'rgba(10,12,24,0.35)';
    ctx.beginPath(); ctx.ellipse(x, y, r * HW, r * HH, 0, 0, Math.PI * 2); ctx.fill();
    for (const g of fx.trail) {
      playerShape(g.x, g.y, p, g.life * 0.35, false);
    }
    playerShape(x, y, p, 1, false);
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
    if (p.dashTime > 0) fx.trail.push({ x: sx(px, py), y: sy(px, py), life: 1 });
  }

  function draw(state, view, params, t) {
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
    items.push({ d: px + py, k: 2 });
    items.sort((a, b) => a.d - b.d || a.k - b.k);

    for (const it of items) {
      if (it.k === 0) drawWall(map, it.tx, it.ty);
      else if (it.k === 1) drawShard(it.s, t);
      else drawPlayer(sx(px, py), sy(px, py), p, params);
    }

    // Outline on top so the player stays visible behind walls.
    playerShape(sx(px, py), sy(px, py), p, 0.3, true);

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
