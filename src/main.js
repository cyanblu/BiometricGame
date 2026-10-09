// Browser entry: fixed-timestep loop, input, HUD and the tunables panel.
import { createState, step, STEP, DEFAULT_PARAMS } from './sim.js';
import { createRenderer } from './render.js';
import { LEVELS } from './levels.js';

const VIEW_DEFAULTS = { zoom: 1, camLag: 0.12 };

// Slider ranges for every tunable. `group` decides where it shows in the panel.
const TUNABLES = [
  { key: 'maxSpeed', label: 'Top speed', unit: 'tiles/s', min: 1, max: 12, step: 0.1, group: 'Movement' },
  { key: 'accel', label: 'Acceleration', unit: 'tiles/s²', min: 2, max: 120, step: 1, group: 'Movement' },
  { key: 'decel', label: 'Deceleration', unit: 'tiles/s²', min: 2, max: 120, step: 1, group: 'Movement' },
  { key: 'radius', label: 'Body radius', unit: 'tiles', min: 0.15, max: 0.45, step: 0.01, group: 'Movement' },
  { key: 'dashSpeed', label: 'Dash speed', unit: 'tiles/s', min: 4, max: 40, step: 0.5, group: 'Dash' },
  { key: 'dashDuration', label: 'Dash duration', unit: 's', min: 0.04, max: 0.5, step: 0.01, group: 'Dash' },
  { key: 'dashCooldown', label: 'Dash cooldown', unit: 's', min: 0, max: 2, step: 0.05, group: 'Dash' },
  { key: 'dashBuffer', label: 'Input buffer', unit: 's', min: 0, max: 0.3, step: 0.01, group: 'Dash' },
  { key: 'zoom', label: 'Zoom', unit: '×', min: 0.5, max: 2.5, step: 0.05, group: 'Camera', view: true },
  { key: 'camLag', label: 'Camera lag', unit: 's', min: 0, max: 0.6, step: 0.01, group: 'Camera', view: true },
];

const STORE_KEY = 'shardfield.tunables.v1';
const BEST_KEY = 'shardfield.best.v1';

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function start(snapshot) {
  const stored = snapshot?.tune ?? load(STORE_KEY) ?? {};
  const params = { ...DEFAULT_PARAMS, ...stored.params };
  const view = { ...VIEW_DEFAULTS, ...stored.view, camX: 0, camY: 0, alpha: 0 };
  let best = load(BEST_KEY) ?? {};

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const renderer = createRenderer(canvas);
  let levelIndex = 0;
  let state = createState(LEVELS[levelIndex]);
  let collectedSeen = 0;
  let started = false;

  function centreCamera() {
    const s = renderer.screenOf(state.player.x, state.player.y);
    view.camX = s.x; view.camY = s.y - 10;
  }
  function restart() {
    state = createState(LEVELS[levelIndex]);
    collectedSeen = 0;
    centreCamera();
    $('win').hidden = true;
  }

  // ---- input -------------------------------------------------------------
  const keys = new Set();
  let dashQueued = false;
  const KEYMAP = {
    ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r',
    ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
  };
  function begin() {
    if (started) return;
    started = true;
    $('intro').hidden = true;
  }
  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('#panel')) return;
    if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); begin(); }
    if ((e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyJ') && !e.repeat) {
      dashQueued = true; e.preventDefault(); begin();
    }
    if (e.code === 'KeyR') { restart(); begin(); }
    if (e.code === 'KeyT') togglePanel();
  });
  window.addEventListener('keyup', (e) => { if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]); });
  window.addEventListener('blur', () => keys.clear());

  // Touch: drag anywhere on the left part of the screen for a floating stick.
  const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
  const STICK_R = 48;
  const knob = $('stick');
  canvas.addEventListener('pointerdown', (e) => {
    begin();
    if (e.pointerType === 'mouse' || stick.id !== null) return;
    stick.id = e.pointerId; stick.ox = e.clientX; stick.oy = e.clientY; stick.x = 0; stick.y = 0;
    canvas.setPointerCapture(e.pointerId);
    knob.hidden = false;
    knob.style.setProperty('--ox', `${e.clientX}px`);
    knob.style.setProperty('--oy', `${e.clientY}px`);
    knob.style.setProperty('--kx', '0px');
    knob.style.setProperty('--ky', '0px');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stick.id) return;
    let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    const d = Math.hypot(dx, dy);
    if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
    stick.x = dx / STICK_R; stick.y = dy / STICK_R;
    knob.style.setProperty('--kx', `${dx}px`);
    knob.style.setProperty('--ky', `${dy}px`);
  });
  const endStick = (e) => {
    if (e.pointerId !== stick.id) return;
    stick.id = null; stick.x = 0; stick.y = 0; knob.hidden = true;
  };
  canvas.addEventListener('pointerup', endStick);
  canvas.addEventListener('pointercancel', endStick);
  $('dash-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); dashQueued = true; begin(); });
  $('intro').addEventListener('pointerdown', begin);

  let padDashWas = false;
  function readInput() {
    let x = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
    let y = (keys.has('d') ? 1 : 0) - (keys.has('u') ? 1 : 0);
    if (x || y) { const l = Math.hypot(x, y); x /= l; y /= l; }
    if (stick.id !== null) {
      const m = Math.hypot(stick.x, stick.y);
      if (m > 0.15) { x = stick.x; y = stick.y; }
    }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      if (Math.hypot(ax, ay) > 0.2) { x = ax; y = ay; begin(); }
      const pressed = !!(pad.buttons[0]?.pressed || pad.buttons[5]?.pressed);
      if (pressed && !padDashWas) { dashQueued = true; begin(); }
      padDashWas = pressed;
      break;
    }
    const dash = dashQueued;
    dashQueued = false;
    return { x, y, dash };
  }

  // ---- tunables panel ----------------------------------------------------
  const panel = $('panel');
  const rows = $('tunables');
  function persist() {
    save(STORE_KEY, { params, view: { zoom: view.zoom, camLag: view.camLag } });
  }
  function valueOf(t) { return t.view ? view[t.key] : params[t.key]; }
  function fmt(t, v) {
    const dec = String(t.step).split('.')[1]?.length ?? 0;
    return Number(v).toFixed(dec);
  }
  function buildPanel() {
    rows.textContent = '';
    let group = null;
    for (const t of TUNABLES) {
      if (t.group !== group) {
        group = t.group;
        const h = document.createElement('h3');
        h.textContent = group;
        rows.append(h);
        if (group === 'Movement') rows.append(modeRow());
      }
      const id = `t-${t.key}`;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<label for="${id}">${t.label}</label><output for="${id}"></output>
        <input type="range" id="${id}" min="${t.min}" max="${t.max}" step="${t.step}">`;
      const input = row.querySelector('input');
      const out = row.querySelector('output');
      input.value = valueOf(t);
      out.textContent = `${fmt(t, valueOf(t))} ${t.unit}`;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (t.view) view[t.key] = v; else params[t.key] = v;
        out.textContent = `${fmt(t, v)} ${t.unit}`;
        persist();
      });
      rows.append(row);
    }
  }
  function modeRow() {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label for="t-diag">Diagonals</label><output></output>
      <select id="t-diag"><option value="screen">Follow the screen</option><option value="grid">Follow the tiles</option></select>`;
    const sel = row.querySelector('select');
    sel.value = params.diagonalMode;
    sel.addEventListener('change', () => { params.diagonalMode = sel.value; persist(); });
    return row;
  }
  function togglePanel(force) {
    const open = force ?? panel.hidden;
    panel.hidden = !open;
    $('tune-btn').setAttribute('aria-expanded', String(open));
  }
  $('tune-btn').addEventListener('click', () => togglePanel());
  $('close-panel').addEventListener('click', () => togglePanel(false));
  $('reset-tune').addEventListener('click', () => {
    Object.assign(params, DEFAULT_PARAMS);
    Object.assign(view, VIEW_DEFAULTS);
    persist(); buildPanel();
    flash('Back to the spec defaults');
  });
  $('copy-tune').addEventListener('click', () => {
    const text = JSON.stringify({ params, view: { zoom: view.zoom, camLag: view.camLag } }, null, 2);
    const out = $('tune-json');
    out.value = text;
    out.hidden = false;
    navigator.clipboard?.writeText(text).then(
      () => flash('Copied. Paste it into the chat to update the spec.'),
      () => { out.select(); flash('Select the text below and copy it.'); },
    ) ?? (out.select(), flash('Select the text below and copy it.'));
  });
  let flashTimer = 0;
  function flash(msg) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---- HUD ---------------------------------------------------------------
  const hudShards = $('hud-shards'), hudTime = $('hud-time'), hudDash = $('hud-dash');
  const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
  function updateHud() {
    hudShards.textContent = `${state.collected} / ${state.shards.length}`;
    hudTime.textContent = fmtTime(state.time);
    const cd = params.dashCooldown > 0 ? 1 - state.player.dashCooldown / params.dashCooldown : 1;
    hudDash.style.setProperty('--fill', String(cd));
    hudDash.classList.toggle('ready', state.player.dashCooldown <= 0);
  }
  function onWin() {
    const name = LEVELS[levelIndex].name;
    const prev = best[name];
    const isBest = prev == null || state.time < prev;
    if (isBest) { best = { ...best, [name]: state.time }; save(BEST_KEY, best); }
    $('win-time').textContent = fmtTime(state.time);
    $('win-best').textContent = isBest ? 'New best for this level.' : `Best: ${fmtTime(prev)}`;
    $('win').hidden = false;
  }
  $('again').addEventListener('click', () => { restart(); begin(); });

  const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
  $('intro-count').textContent = WORDS[state.shards.length] ?? String(state.shards.length);

  // ---- loop --------------------------------------------------------------
  function resize() { renderer.resize(); }
  window.addEventListener('resize', resize);
  resize();
  buildPanel();
  centreCamera();

  let last = performance.now();
  let acc = 0;
  let clock = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    clock += dt;
    if (started) {
      acc += dt;
      let input = readInput();
      while (acc >= STEP) {
        const wasWon = state.won;
        step(state, input, params);
        input = { ...input, dash: false }; // a press counts once
        acc -= STEP;
        if (!wasWon && state.won) onWin();
      }
    }
    view.alpha = started ? acc / STEP : 1;
    const p = state.player;
    const ix = p.px + (p.x - p.px) * view.alpha, iy = p.py + (p.y - p.py) * view.alpha;
    while (collectedSeen < state.collected) {
      const s = state.shards.find((q) => q.taken && !q.burst);
      if (s) { s.burst = true; renderer.burst(s.x, s.y); }
      collectedSeen++;
    }
    renderer.updateFx(dt, p, ix, iy);
    // Camera eases toward the player; lag is the time constant in seconds.
    const target = renderer.screenOf(ix, iy);
    const k = view.camLag > 0 ? 1 - Math.exp(-dt / view.camLag) : 1;
    view.camX += (target.x - view.camX) * k;
    view.camY += (target.y - 10 - view.camY) * k;
    const fit = Math.min(renderer.size.w, renderer.size.h) / 560;
    renderer.draw(state, { ...view, zoom: view.zoom * Math.min(1.6, Math.max(0.75, fit)) }, params, clock);
    updateHud();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.claude?.hot?.snapshot?.(() => ({ tune: { params, view: { zoom: view.zoom, camLag: view.camLag } } }));
}

const hot = window.claude?.hot;
if (hot?.ready) hot.ready(start); else start(hot?.data ?? {});
