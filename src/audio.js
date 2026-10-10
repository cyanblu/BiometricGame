// Sound: a layered threat score and rain, all synthesized with Web Audio.
// Browser only (not part of the pure simulation). Eight layers fade in one by
// one as threat rises; each picks a new pattern from a small pool every bar,
// so it doesn't loop. Each biome has its own root note and scale. The rain is
// filtered noise that swells with the cycle, plus a low rumble and a slow,
// pitched-down organ chord in the downpour. Percussion is "junk audio": noise
// bursts through resonant filters, like slapping a ruler on a table.

// Root (Hz) and scale (semitones) per biome: yard, garden, foundry, drains, hive.
const AUDIO_BIOMES = [
  { root: 55, scale: [0, 3, 5, 7, 10] },
  { root: 61.7, scale: [0, 2, 3, 7, 9] },
  { root: 49, scale: [0, 1, 5, 7, 8] },
  { root: 58.3, scale: [0, 3, 7, 10, 14] },
  { root: 46.2, scale: [0, 1, 4, 6, 7] },
];
const LAYERS = 8;
const BPM = 96;

export function createAudio() {
  let ac = null, master, layerGain = [], rainGain, rumbleGain, organGain, organOscs = [];
  let noiseBuf = null, muted = false, nextStep = 0, stepIx = 0;
  const patterns = Array(LAYERS).fill(null);
  let biome = 0, threat = 0, rain = 0;
  const level = Array(LAYERS).fill(0);

  const pick = (pool) => pool[Math.floor(Math.random() * pool.length)];
  const freq = (deg, oct = 0) => {
    const b = AUDIO_BIOMES[biome], n = b.scale.length;
    const s = b.scale[((deg % n) + n) % n] + 12 * (oct + Math.floor(deg / n));
    return b.root * 2 ** (s / 12);
  };

  function start() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = muted ? 0 : 0.5;
    const comp = ac.createDynamicsCompressor();
    master.connect(comp); comp.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    for (let i = 0; i < LAYERS; i++) { const g = ac.createGain(); g.gain.value = 0; g.connect(master); layerGain.push(g); }
    // Layer 0: an always-on drone.
    for (const det of [-6, 5]) {
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq(0, -1); o.detune.value = det;
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 240;
      o.connect(f); f.connect(layerGain[0]); o.start();
      organOscs.push({ o, base: 0, oct: -1 });
    }
    // Rain: band-passed noise, plus a low rumble.
    const loop = (type, fq, q) => {
      const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = fq; f.Q.value = q;
      const g = ac.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(master); src.start();
      return g;
    };
    rainGain = loop('bandpass', 2400, 0.4);
    rumbleGain = loop('lowpass', 180, 0.7);
    // Organ for the downpour: detuned, pitched-down sines, slowly swelling.
    organGain = ac.createGain(); organGain.gain.value = 0; organGain.connect(master);
    for (const [deg, det] of [[0, -9], [2, 7], [4, -4], [0, 12]]) {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = freq(deg, 0) * 0.98; o.detune.value = det;
      const ws = ac.createWaveShaper(); ws.curve = distortion(8);
      o.connect(ws); ws.connect(organGain); o.start();
      organOscs.push({ o, base: deg, oct: 0, organ: true });
    }
    nextStep = ac.currentTime + 0.1;
  }

  function distortion(k) {
    const n = 256, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    return c;
  }

  // ---- instruments ----
  function noiseHit(t, out, { type = 'bandpass', f = 2000, q = 8, dur = 0.08, gain = 0.5 }) {
    const src = ac.createBufferSource(); src.buffer = noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(fl); fl.connect(g); g.connect(out); src.start(t, Math.random()); src.stop(t + dur + 0.02);
  }
  function tone(t, out, { f, type = 'square', dur = 0.15, gain = 0.2, cut = 900, bend = 1 }) {
    const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    if (bend !== 1) o.frequency.exponentialRampToValueAtTime(f * bend, t + dur);
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = cut;
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(fl); fl.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.02);
  }

  // Pattern pools: 16 sixteenth steps; numbers are scale degrees (or 1 = hit).
  const POOLS = [
    null, // drone runs continuously
    [[1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0]], // sub pulse
    [[0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1], [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0]], // ticks
    [[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1], [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0]], // junk clanks
    [[0, -1, -1, 0, -1, -1, 3, -1, 0, -1, -1, 2, -1, -1, 1, -1], [0, -1, 0, -1, 4, -1, -1, 3, -1, -1, 0, -1, 2, -1, -1, -1]], // bass
    [[0, 2, 4, 2, 5, 4, 2, 4, 0, 2, 4, 7, 5, 4, 2, 1], [4, -1, 2, -1, 0, -1, 2, 3, 4, -1, 5, -1, 4, -1, 2, -1]], // arpeggio
    [[-1, -1, -1, 9, -1, -1, -1, -1, -1, -1, 7, -1, -1, -1, -1, -1], [-1, 8, -1, -1, -1, -1, -1, 6, -1, -1, -1, -1, 10, -1, -1, -1]], // pings
    [[0, -1, -1, -1, -1, -1, -1, -1, 3, -1, -1, -1, -1, -1, -1, -1]], // organ stabs
  ];

  function schedule() {
    const stepDur = 60 / BPM / 4;
    while (nextStep < ac.currentTime + 0.15) {
      const t = nextStep, i = stepIx % 16;
      if (i === 0) for (let l = 1; l < LAYERS; l++) patterns[l] = pick(POOLS[l]);
      for (let l = 1; l < LAYERS; l++) {
        if (level[l] < 0.02) continue;
        const v = patterns[l][i], out = layerGain[l];
        if (l === 1 && v) tone(t, out, { f: freq(0, -1) * 1.0, type: 'sine', dur: 0.35, gain: 0.8, cut: 200, bend: 0.5 });
        if (l === 2 && v) noiseHit(t, out, { type: 'highpass', f: 6000, q: 1, dur: 0.03, gain: 0.25 });
        if (l === 3 && v) noiseHit(t, out, { f: 300 + Math.random() * 1800, q: 25, dur: 0.18, gain: 0.9 });
        if (l === 4 && v >= 0) tone(t, out, { f: freq(v, 0), dur: 0.22, gain: 0.25, cut: 500 });
        if (l === 5 && v >= 0) tone(t, out, { f: freq(v, 2), type: 'triangle', dur: 0.12, gain: 0.12, cut: 3000 });
        if (l === 6 && v >= 0) tone(t, out, { f: freq(v, 3), type: 'sine', dur: 0.6, gain: 0.08, cut: 6000 });
        if (l === 7 && v >= 0) tone(t, out, { f: freq(v, 1), type: 'sawtooth', dur: 0.9, gain: 0.12, cut: 1200 });
      }
      nextStep += stepDur; stepIx++;
    }
  }

  function update(dt, opts) {
    if (!ac) return;
    threat = opts.threat; rain = opts.rain;
    if (opts.biome !== biome) {
      biome = opts.biome;
      for (const q of organOscs) q.o.frequency.setTargetAtTime(freq(q.base, q.oct) * (q.organ ? 0.98 : 1), ac.currentTime, 0.8);
    }
    // Layer l comes in once threat passes l / LAYERS; the drone is always there.
    for (let l = 0; l < LAYERS; l++) {
      const want = l === 0 ? 0.08 + threat * 0.1 : Math.max(0, Math.min(1, (threat * LAYERS - l + 1)));
      level[l] += (want - level[l]) * Math.min(1, dt * 2);
      layerGain[l].gain.setTargetAtTime(level[l] * (l === 0 ? 1 : 0.6), ac.currentTime, 0.1);
    }
    const now = ac.currentTime;
    rainGain.gain.setTargetAtTime(0.03 + rain * 0.35, now, 0.5);
    rumbleGain.gain.setTargetAtTime(rain >= 0.99 ? 0.5 : rain * 0.15, now, 0.8);
    organGain.gain.setTargetAtTime(rain >= 0.99 ? 0.05 : 0, now, 2);
    schedule();
  }

  function toggle() {
    muted = !muted;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.5, ac.currentTime, 0.05);
    return muted;
  }

  return { start, update, toggle, get muted() { return muted; } };
}
