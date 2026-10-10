// Pixel filter: output is always made of palette colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, COLORS, buildLut, quantize, hexToRgb } from '../src/pixel.js';

const table = buildLut();
const key = (r, g, b) => `${r},${g},${b}`;
const allowed = new Set(PALETTE.map((h) => key(...hexToRgb(h))));

function noise(w, h, seed = 9) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; d[i] = seed >>> 24; }
  return d;
}

test('every output pixel is a palette colour, with and without dither', () => {
  for (const dither of [0, 16]) {
    const d = quantize(noise(64, 48), 64, 48, table, dither);
    for (let i = 0; i < d.length; i += 4) {
      assert.ok(allowed.has(key(d[i], d[i + 1], d[i + 2])), `pixel ${i / 4}`);
      assert.equal(d[i + 3], 255);
    }
  }
});

test('every palette colour maps to itself (none is unreachable)', () => {
  // Fails if two palette colours fall into the same 15-bit lookup cell.
  for (const hex of PALETTE) {
    const [r, g, b] = hexToRgb(hex);
    const d = quantize(new Uint8ClampedArray([r, g, b, 255]), 1, 1, table, 0);
    assert.deepEqual([...d.slice(0, 3)], [r, g, b], hex);
  }
});

test('dither turns a flat in-between colour into a mix of two palette colours', () => {
  const [a, b] = [hexToRgb(COLORS.conc1), hexToRgb(COLORS.conc2)];
  const mid = a.map((v, i) => Math.round((v + b[i]) / 2));
  const d = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < d.length; i += 4) d.set([...mid, 255], i);
  quantize(d, 16, 16, table, 24);
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4) seen.add(key(d[i], d[i + 1], d[i + 2]));
  assert.ok(seen.size >= 2, `only ${seen.size} colour(s)`);
});
