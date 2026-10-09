// Second-order motion: y follows x with the "personality" set by
//   f    natural frequency in Hz (how fast it responds)
//   zeta damping (0 = rings forever, <1 overshoots, >=1 settles without overshoot)
//   r    initial response (<0 anticipates, 0 eases in, >1 overshoots at the start)
// Equation: y + k1*y' + k2*y'' = x + k3*x'. Solved with semi-implicit Euler,
// with k2 clamped so a long frame can never make it blow up.
// Pure: no DOM, no randomness. See docs/SPEC.md, "Procedural motion".

export function motionConstants(f, zeta, r) {
  const w = 2 * Math.PI * f;
  return { k1: zeta / (Math.PI * f), k2: 1 / (w * w), k3: (r * zeta) / w };
}

// Works on numbers or arrays of numbers (one independent follower per component).
export function createFollower(x0, f, zeta, r) {
  const arr = Array.isArray(x0);
  const n = arr ? x0.length : 1;
  const xp = arr ? [...x0] : [x0];
  return {
    y: [...xp], yd: new Array(n).fill(0), xp,
    k: motionConstants(f, zeta, r),
    arr,
    get value() { return this.arr ? this.y : this.y[0]; },
  };
}

export function setMotion(fol, f, zeta, r) {
  fol.k = motionConstants(f, zeta, r);
}

export function resetFollower(fol, x) {
  const xs = fol.arr ? x : [x];
  for (let i = 0; i < xs.length; i++) { fol.y[i] = xs[i]; fol.yd[i] = 0; fol.xp[i] = xs[i]; }
}

export function follow(fol, T, x, xd) {
  if (T <= 0) return fol.value;
  const xs = fol.arr ? x : [x];
  const { k1, k2, k3 } = fol.k;
  // Smallest k2 that keeps semi-implicit Euler stable (and free of
  // frame-to-frame jitter) for this time step.
  const k2s = Math.max(k2, (T * T) / 2 + (T * k1) / 2, T * k1);
  for (let i = 0; i < xs.length; i++) {
    const v = xd === undefined ? (xs[i] - fol.xp[i]) / T : (fol.arr ? xd[i] : xd);
    fol.xp[i] = xs[i];
    fol.y[i] += T * fol.yd[i];
    fol.yd[i] += (T * (xs[i] + k3 * v - fol.y[i] - k1 * fol.yd[i])) / k2s;
  }
  return fol.value;
}

// Step response sampled at `samples` points over `seconds`, for the panel plot.
export function stepResponse(f, zeta, r, seconds = 2, samples = 120) {
  const fol = createFollower(0, f, zeta, r);
  const T = seconds / samples;
  const out = [];
  for (let i = 0; i < samples; i++) out.push(follow(fol, T, 1));
  return out;
}
