// Pixel-art look: a fixed, grungy industrial palette and a post-process that
// snaps every pixel of the low-resolution frame to it, with optional ordered
// (Bayer) dithering. Pure: works on plain RGBA arrays, so it runs in Node too.

// Every colour the world is drawn with. Ramps go dark to light.
export const COLORS = {
  void0: '#0b0d10', void1: '#14181c', void2: '#1d2228',
  conc0: '#262b2c', conc1: '#2f3534', conc2: '#3a403d', conc3: '#4a4f49',
  grime: '#33291f',
  rust0: '#4f3220', rust1: '#74462a', rust2: '#9a6036',
  moss0: '#242e1d', moss1: '#35442a', moss2: '#4f6136', moss3: '#6e7f45',
  puddle0: '#15262e', puddle1: '#29404a',
  metal0: '#222a30', metal1: '#2c363c', metal2: '#3c4950', metal3: '#566670', metal4: '#7a8c94',
  lamp0: '#c98a3a', lamp1: '#f2c15a',
  cell0: '#8f9a2a', cell1: '#c8d43c', cell2: '#f4f7a0',
  elec0: '#2fa6c8', elec1: '#6fe6ff', elec2: '#d2fbff',
  hot0: '#c2412b', hot1: '#ff7a3c',
  hull0: '#6b6a64', hull1: '#a19d90', hull2: '#d1cbbb',
  limb: '#101315',
  beetleA0: '#2a3318', beetleA1: '#4a5a24',
  beetleB0: '#3b2516', beetleB1: '#6a4228',
  bone: '#e8e4d6',
};

export const PALETTE = [...new Set(Object.values(COLORS))];

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Nearest palette entry for every 15-bit colour (5 bits per channel).
// Distance is weighted toward green, which the eye is most sensitive to.
export function buildLut(palette = PALETTE) {
  const rgb = new Uint8Array(palette.length * 3);
  palette.forEach((hex, i) => rgb.set(hexToRgb(hex), i * 3));
  const lut = new Uint8Array(32768);
  for (let i = 0; i < 32768; i++) {
    const r = ((i >> 10) & 31) * 8 + 4, g = ((i >> 5) & 31) * 8 + 4, b = (i & 31) * 8 + 4;
    let best = 0, bestD = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const dr = r - rgb[p * 3], dg = g - rgb[p * 3 + 1], db = b - rgb[p * 3 + 2];
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) { bestD = d; best = p; }
    }
    lut[i] = best;
  }
  return { lut, rgb, size: palette.length };
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// In place. dither: 0 = plain nearest colour; ~8-24 gives visible patterns.
export function quantize(data, width, height, table, dither = 0) {
  const { lut, rgb } = table;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = dither ? (BAYER4[((y & 3) << 2) | (x & 3)] / 16 - 0.5) * dither : 0;
      const r = Math.min(255, Math.max(0, data[i] + o));
      const g = Math.min(255, Math.max(0, data[i + 1] + o));
      const b = Math.min(255, Math.max(0, data[i + 2] + o));
      const p = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)] * 3;
      data[i] = rgb[p]; data[i + 1] = rgb[p + 1]; data[i + 2] = rgb[p + 2]; data[i + 3] = 255;
    }
  }
  return data;
}
