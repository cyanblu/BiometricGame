// Vitals panel: health and charges as a biomechanical pixel-art sprite in the
// spirit of H. R. Giger (bone vertebrae on a spinal cord, ribbed seed pods,
// a beating organ in a ribbed cocoon, a halftone backplate). It is painted
// with real shading (gradients, glows), then snapped to the game palette with
// the same ordered dither as the world, so it reads as part of the same image.
import { COLORS, buildLut, quantize } from './pixel.js';

export const VITALS_W = 168;
export const VITALS_H = 52;
const VC = COLORS;

export function createVitals(canvas) {
  canvas.width = VITALS_W;
  canvas.height = VITALS_H;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const lut = buildLut();
  const SPINE_Y = 15, POD_Y = 30, X0 = 36, STEP = 13;

  const lin = (x0, y0, x1, y1, stops) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    return gr;
  };
  const rad = (x, y, r0, r1, stops, ox = x, oy = y) => {
    const gr = g.createRadialGradient(ox, oy, r0, x, y, r1);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    return gr;
  };
  const ellipse = (x, y, rx, ry) => { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); };

  // Halftone: a 3 px dot screen whose dot size follows `amount(x, y)` (0..1).
  function halftone(x0, y0, w, h, color, amount) {
    g.fillStyle = color;
    for (let y = y0 + 1; y < y0 + h; y += 3) {
      for (let x = x0 + ((y / 3) & 1 ? 1 : 2); x < x0 + w; x += 3) {
        const a = amount(x, y);
        if (a <= 0.05) continue;
        const r = 0.35 + a * 1.1;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    }
  }

  function backplate() {
    // Ribbed slab behind spine and pods, with teeth along both edges.
    g.beginPath();
    g.moveTo(26, 6);
    for (let x = 26; x < 162; x += 6.5) { g.lineTo(x + 2, 6); g.lineTo(x + 3.5, 3.5); g.lineTo(x + 5, 6); }
    g.quadraticCurveTo(168, 6, 167, 26);
    g.quadraticCurveTo(168, 47, 160, 47);
    for (let x = 160; x > 26; x -= 6.5) { g.lineTo(x - 2, 47); g.lineTo(x - 3.5, 49.5); g.lineTo(x - 5, 47); }
    g.closePath();
    g.fillStyle = lin(0, 4, 0, 50, [[0, VC.void2], [0.45, VC.void1], [1, VC.void0]]);
    g.fill();
    g.save(); g.clip();
    halftone(26, 4, 142, 46, VC.metal0, (x, y) => 0.9 - Math.abs(y - 26) / 26 - (x - 26) / 400);
    // Grooves between the rows.
    g.fillStyle = VC.void0; g.fillRect(26, 27, 142, 1);
    g.fillStyle = VC.metal1; g.fillRect(26, 28, 142, 1);
    g.restore();
    g.strokeStyle = VC.metal1; g.lineWidth = 1; g.stroke();
  }

  function cord(y, x0, x1) {
    g.fillStyle = lin(0, y - 2, 0, y + 2, [[0, VC.metal2], [0.35, VC.metal1], [1, VC.void0]]);
    g.fillRect(x0, y - 2, x1 - x0, 4);
    g.fillStyle = VC.void0;
    for (let x = x0 + 2; x < x1; x += 4) g.fillRect(x, y - 2, 1, 4); // segments
    g.fillStyle = VC.metal3;
    for (let x = x0; x < x1; x += 4) g.fillRect(x, y - 2, 2, 1); // sheen
  }

  function organ(t, bpm, charges, overheated) {
    const cx = 17, cy = 26;
    // Hoses out of the cocoon into the spine and the pod row.
    for (const [y0, y1] of [[18, SPINE_Y], [34, POD_Y + 9]]) {
      g.strokeStyle = VC.void0; g.lineWidth = 4;
      g.beginPath(); g.moveTo(cx + 8, y0); g.bezierCurveTo(cx + 14, y0, cx + 12, y1, X0, y1); g.stroke();
      g.strokeStyle = VC.metal2; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx + 8, y0 - 1); g.bezierCurveTo(cx + 14, y0 - 1, cx + 12, y1 - 1, X0, y1 - 1); g.stroke();
    }
    // Cocoon: elongated bone shell, lit from the upper left.
    ellipse(cx, cy, 15, 24);
    g.fillStyle = rad(cx, cy, 2, 26, [[0, VC.bone], [0.35, VC.hull2], [0.6, VC.hull1], [0.85, VC.hull0], [1, VC.metal1]], cx - 5, cy - 9);
    g.fill();
    g.save(); ellipse(cx, cy, 15, 24); g.clip();
    // Ribs: shadow below, highlight above.
    for (let k = -6; k <= 6; k++) {
      const y = cy + k * 3.4;
      const half = 15 * Math.sqrt(Math.max(0, 1 - ((y - cy) / 24) ** 2));
      g.fillStyle = VC.hull0; g.fillRect(cx - half, y + 1, half * 2, 1);
      g.fillStyle = VC.bone; g.fillRect(cx - half + 2, y, half * 1.2, 1);
    }
    halftone(cx - 15, cy - 24, 30, 48, VC.metal1, (x, y) => ((x - cx) / 15 + (y - cy) / 24) * 0.8);
    g.restore();
    // Socket.
    ellipse(cx, cy + 1, 7.5, 14);
    g.fillStyle = rad(cx, cy + 1, 1, 14, [[0, VC.void0], [0.7, VC.void1], [1, VC.metal0]]);
    g.fill();
    g.strokeStyle = VC.hull0; g.lineWidth = 1; g.stroke();
    // Heart: a double beat at the bug's pulse; dark when out of charge.
    const dead = charges <= 0;
    const ph = (t * bpm / 60) % 1;
    const beat = dead ? 0 : Math.max(Math.exp(-ph * 14), 0.7 * Math.exp(-Math.abs(ph - 0.22) * 18));
    const r = 3.2 + beat * 2.6;
    ellipse(cx, cy + 2, r, r * 1.45);
    g.fillStyle = dead
      ? rad(cx, cy + 2, 0, r * 1.45, [[0, VC.blood0], [1, VC.void0]])
      : rad(cx, cy + 2, 0, r * 1.45, [[0, overheated ? VC.hot1 : VC.blood2], [0.6, VC.blood1], [1, VC.blood0]], cx - 1, cy);
    g.fill();
    if (!dead) {
      // Glow spilling into the socket.
      g.globalCompositeOperation = 'lighter';
      ellipse(cx, cy + 2, 7, 12);
      g.fillStyle = rad(cx, cy + 2, 0, 12, [[0, `rgba(184,38,42,${0.25 + beat * 0.35})`], [1, 'rgba(184,38,42,0)']]);
      g.fill();
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = VC.bone; g.fillRect(cx - 2, cy - 1, 1, 2); // specular
    }
    // Vessels into the socket.
    g.strokeStyle = VC.limb; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, cy - 13); g.quadraticCurveTo(cx + 2, cy - 7, cx, cy - 3); g.stroke();
    g.beginPath(); g.moveTo(cx, cy + 15); g.quadraticCurveTo(cx - 2, cy + 10, cx, cy + 7); g.stroke();
  }

  function vertebra(x, full, flash, t, i, low) {
    const y0 = SPINE_Y - 9, y1 = SPINE_Y + 9;
    const bone = lin(x, 0, x + 11, 0, [[0, VC.hull0], [0.25, VC.bone], [0.5, VC.hull1], [0.8, VC.hull0], [1, VC.metal1]]);
    // Spinous processes, top and bottom.
    g.fillStyle = bone;
    g.beginPath(); g.moveTo(x + 3, y0 + 1); g.lineTo(x + 5, y0 - 5); g.lineTo(x + 6.5, y0 - 4); g.lineTo(x + 8, y0 + 1); g.fill();
    g.beginPath(); g.moveTo(x + 3, y1 - 1); g.lineTo(x + 5.5, y1 + 4); g.lineTo(x + 8, y1 - 1); g.fill();
    // Transverse wings reaching into the gap.
    g.fillStyle = VC.hull0;
    g.beginPath(); g.moveTo(x + 10, SPINE_Y - 5); g.quadraticCurveTo(x + 13, SPINE_Y - 4, x + 12.5, SPINE_Y - 1); g.lineTo(x + 10, SPINE_Y - 2); g.fill();
    g.beginPath(); g.moveTo(x + 10, SPINE_Y + 5); g.quadraticCurveTo(x + 13, SPINE_Y + 4, x + 12.5, SPINE_Y + 1); g.lineTo(x + 10, SPINE_Y + 2); g.fill();
    // Body.
    g.beginPath();
    g.moveTo(x + 1, y0); g.lineTo(x + 10, y0); g.quadraticCurveTo(x + 11, SPINE_Y, x + 10, y1);
    g.lineTo(x + 1, y1); g.quadraticCurveTo(x, SPINE_Y, x + 1, y0); g.closePath();
    g.fillStyle = bone; g.fill();
    g.strokeStyle = VC.metal0; g.lineWidth = 1; g.stroke();
    g.save(); g.clip();
    halftone(x, y0, 11, 18, VC.hull0, (px, py) => (px - x) / 11 * 0.9 + (py - y0) / 40);
    g.fillStyle = VC.hull2; g.fillRect(x + 1, y0 + 2, 9, 1); // growth ridges
    g.fillStyle = VC.hull0; g.fillRect(x + 1, y0 + 3, 9, 1); g.fillRect(x + 1, y1 - 3, 9, 1);
    g.restore();
    // Glass capsule.
    const cx = x + 3, cy = y0 + 3, cw = 5, ch = 12;
    g.fillStyle = VC.void0; g.fillRect(cx, cy, cw, ch);
    if (flash) {
      g.fillStyle = VC.bone; g.fillRect(cx, cy, cw, ch);
    } else if (full) {
      const wob = low ? Math.max(0, Math.round(Math.sin(t * 9 + i) * 1.2)) : 0;
      g.fillStyle = lin(0, cy, 0, cy + ch, [[0, VC.blood2], [0.45, VC.blood1], [1, VC.blood0]]);
      g.fillRect(cx, cy + 1 + wob, cw, ch - 1 - wob);
      g.fillStyle = VC.hot1; g.fillRect(cx + (Math.floor(t * 4 + i) % cw), cy + 1 + wob, 1, 1); // meniscus glint
      g.fillStyle = 'rgba(232,228,214,0.55)'; g.fillRect(cx + 1, cy + 2, 1, ch - 4); // glass sheen
    } else {
      // Drained and cracked, dried residue at the bottom.
      halftone(cx, cy + ch - 5, cw, 5, VC.blood0, (px, py) => (py - (cy + ch - 5)) / 5);
      g.strokeStyle = VC.hull0; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx + 1, cy + 2); g.lineTo(cx + 3, cy + 5); g.lineTo(cx + 2, cy + 7); g.lineTo(cx + 4, cy + 9); g.stroke();
    }
    g.strokeStyle = VC.metal1; g.lineWidth = 1; g.strokeRect(cx - 0.5, cy - 0.5, cw + 1, ch + 1);
  }

  function pod(x, n, empty, t, i) {
    const y0 = POD_Y, y1 = POD_Y + 18, cx = x + 5.5;
    // Seed-pod shell.
    g.beginPath();
    g.moveTo(cx, y0 - 1);
    g.bezierCurveTo(x + 12, y0, x + 12, y1 - 3, cx, y1 + 1);
    g.bezierCurveTo(x - 1, y1 - 3, x - 1, y0, cx, y0 - 1);
    g.closePath();
    g.fillStyle = rad(cx, (y0 + y1) / 2, 1, 12, [[0, VC.hull1], [0.55, VC.hull0], [1, VC.metal0]], x + 3, y0 + 3);
    g.fill();
    g.save(); g.clip();
    halftone(x - 1, y0 - 1, 13, 21, VC.metal0, (px, py) => (px - x) / 12 * 0.7 + (py - y0) / 30);
    g.restore();
    g.strokeStyle = VC.void1; g.lineWidth = 1; g.stroke();
    // Window with three cells, filled from the bottom.
    const wx = x + 3, ww = 6;
    g.fillStyle = VC.void0; g.fillRect(wx, y0 + 2, ww, 15);
    for (let s = 0; s < 3; s++) {
      const sy = y0 + 12 - s * 5;
      if (s < n) {
        g.fillStyle = lin(0, sy, 0, sy + 4, [[0, VC.cell2], [0.4, VC.cell1], [1, VC.cell0]]);
        g.fillRect(wx, sy, ww, 4);
        g.globalCompositeOperation = 'lighter';
        const flick = 0.18 + 0.08 * Math.sin(t * 5 + i * 1.7 + s);
        g.fillStyle = rad(wx + 3, sy + 2, 0, 6, [[0, `rgba(200,212,60,${flick})`], [1, 'rgba(200,212,60,0)']]);
        g.fillRect(wx - 3, sy - 3, ww + 6, 10);
        g.globalCompositeOperation = 'source-over';
      } else {
        g.fillStyle = VC.void1; g.fillRect(wx, sy, ww, 4);
        if (empty) halftone(wx, sy, ww, 4, VC.void2, () => 0.5);
      }
      g.fillStyle = VC.hull0; g.fillRect(wx, sy + 4, ww, 1); // rib between cells
    }
    g.fillStyle = VC.metal1; g.fillRect(wx, y0 + 2, 1, 15); // window edge shadow
  }

  // v: { health, maxHealth, charges, maxCharges, bpm, overheated, flash (s), t }
  function draw(v) {
    g.clearRect(0, 0, VITALS_W, VITALS_H);
    backplate();
    cord(SPINE_Y, X0 - 4, 164);
    cord(POD_Y + 19, X0 - 4, 164);
    const low = v.health <= 3;
    for (let i = 0; i < v.maxHealth; i++) {
      vertebra(X0 + i * STEP, i < v.health, v.flash > 0 && i < v.health, v.t, i, low);
    }
    const pods = Math.ceil(v.maxCharges / 3);
    for (let i = 0; i < pods; i++) {
      pod(X0 + i * STEP, Math.max(0, Math.min(3, v.charges - i * 3)), v.charges <= 0, v.t, i);
    }
    organ(v.t, v.bpm, v.charges, v.overheated);
    // Snap to the game palette with ordered dither; keep the outline crisp.
    const img = g.getImageData(0, 0, VITALS_W, VITALS_H);
    const alpha = new Uint8Array(VITALS_W * VITALS_H);
    for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
    quantize(img.data, VITALS_W, VITALS_H, lut, 14);
    for (let i = 0; i < alpha.length; i++) img.data[i * 4 + 3] = alpha[i] >= 128 ? 255 : 0;
    g.putImageData(img, 0, 0);
  }

  return { draw };
}
