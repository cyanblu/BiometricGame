// Vitals panel: health and charges as a biomechanical pixel-art sprite in the
// spirit of H. R. Giger (bone vertebrae, ribs, black tubing, an organ that
// beats). Drawn pixel by pixel at 132 x 40 and scaled up without smoothing,
// so its pixels stay crisp whatever the zoom of the world.
import { COLORS } from './pixel.js';

export const VITALS_W = 132;
export const VITALS_H = 40;
const VC = COLORS;

export function createVitals(canvas) {
  canvas.width = VITALS_W;
  canvas.height = VITALS_H;
  const g = canvas.getContext('2d');
  const px = (x, y, c, w = 1, h = 1) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

  function tube(x0, x1, y) {
    px(x0, y - 1, VC.limb, x1 - x0, 3);
    px(x0, y - 1, VC.metal1, x1 - x0, 1);
    for (let x = x0 + 1; x < x1; x += 4) px(x, y + 1, VC.void2); // ribbed hose
  }

  // One vertebra holding a blood capsule. full: 0 lost, 1 full.
  function vertebra(x, y, full, flash, t, i, low) {
    // Spinous processes top and bottom.
    px(x + 3, y - 2, VC.hull1, 2, 2); px(x + 4, y - 3, VC.hull2);
    px(x + 3, y + 12, VC.hull1, 2, 2); px(x + 4, y + 14, VC.hull0);
    // Body with chipped corners.
    px(x, y + 1, VC.hull1, 8, 10); px(x + 1, y, VC.hull1, 6, 1); px(x + 1, y + 11, VC.hull0, 6, 1);
    px(x, y + 1, VC.hull2, 1, 9); px(x + 7, y + 2, VC.hull0, 1, 9);
    // Ribs reaching into the gap.
    px(x + 8, y + 3, VC.hull0); px(x + 9, y + 4, VC.hull0); px(x + 8, y + 8, VC.hull0); px(x + 9, y + 7, VC.hull0);
    // Capsule.
    px(x + 2, y + 2, VC.void0, 4, 8);
    if (flash) { px(x + 2, y + 2, VC.bone, 4, 8); return; }
    if (full) {
      const wob = low ? Math.round(Math.sin(t * 8 + i) * 0.8) : 0;
      px(x + 2, y + 3 + Math.max(0, wob), VC.blood1, 4, 7 - Math.max(0, wob));
      px(x + 2, y + 3, VC.blood2, 1, 7);
      px(x + 3 + (Math.floor(t * 3 + i) % 3), y + 3, VC.hot1); // meniscus glint
    } else {
      px(x + 3, y + 4, VC.hull0); px(x + 4, y + 5, VC.hull0); px(x + 3, y + 6, VC.hull0); px(x + 4, y + 8, VC.hull0);
      px(x + 2, y + 9, VC.blood0, 4, 1); // dried residue
    }
  }

  // One housing of three cell slots. n: how many of its 3 slots are charged.
  function housing(x, y, n, empty) {
    px(x, y, VC.hull0, 8, 15); px(x + 1, y - 1, VC.hull0, 6, 1);
    px(x, y, VC.hull1, 1, 14); px(x + 7, y + 1, VC.metal1, 1, 14);
    px(x + 3, y + 15, VC.hull0, 2, 2); // a little tail joint
    for (let s = 0; s < 3; s++) {
      const sy = y + 10 - s * 4; // fill from the bottom up
      px(x + 2, sy, VC.void0, 4, 3);
      if (s < n) {
        px(x + 2, sy, VC.cell1, 4, 3);
        px(x + 2, sy, VC.cell2, 4, 1);
      } else if (empty) {
        px(x + 3, sy + 1, VC.void2, 2, 1);
      }
    }
  }

  function organ(t, bpm, charges, overheated) {
    // Elongated, ribbed cranium-like capsule.
    g.fillStyle = VC.hull0;
    g.beginPath(); g.ellipse(11, 20, 10, 18, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = VC.hull1;
    g.beginPath(); g.ellipse(10, 19, 9, 17, 0, 0, Math.PI * 2); g.fill();
    for (let y = 5; y < 36; y += 3) px(3 + Math.abs(20 - y) / 4, y, VC.hull0, 14 - Math.abs(20 - y) / 2, 1);
    g.fillStyle = VC.void0;
    g.beginPath(); g.ellipse(11, 20, 5, 10, 0, 0, Math.PI * 2); g.fill();
    const dead = charges <= 0;
    // Heart: two quick beats per cycle, at the bug's pulse.
    const ph = (t * bpm / 60) % 1;
    const beat = dead ? 0 : Math.max(Math.exp(-ph * 14), 0.7 * Math.exp(-Math.abs(ph - 0.22) * 18));
    const r = 2 + beat * 2.5;
    g.fillStyle = dead ? VC.blood0 : overheated ? VC.hot0 : VC.blood1;
    g.beginPath(); g.ellipse(11, 21, r, r * 1.3, 0, 0, Math.PI * 2); g.fill();
    if (!dead) {
      g.fillStyle = beat > 0.5 ? VC.hot1 : VC.blood2;
      g.beginPath(); g.ellipse(10.5, 20, r * 0.45, r * 0.6, 0, 0, Math.PI * 2); g.fill();
    }
    // Vessels running into the socket.
    px(11, 9, VC.limb, 1, 5); px(11, 28, VC.limb, 1, 5);
  }

  // v: { health, maxHealth, charges, maxCharges, bpm, overheated, flash (s), t }
  function draw(v) {
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, VITALS_W, VITALS_H);
    tube(18, VITALS_W - 2, 10);
    tube(18, VITALS_W - 2, 30);
    organ(v.t, v.bpm, v.charges, v.overheated);
    const low = v.health <= 3;
    for (let i = 0; i < v.maxHealth; i++) {
      vertebra(26 + i * 10, 4, i < v.health, v.flash > 0 && i < v.health, v.t, i, low);
    }
    const housings = Math.ceil(v.maxCharges / 3);
    for (let i = 0; i < housings; i++) {
      const n = Math.max(0, Math.min(3, v.charges - i * 3));
      housing(26 + i * 10, 22, n, v.charges <= 0);
    }
  }

  return { draw };
}
