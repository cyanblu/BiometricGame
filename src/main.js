// Browser entry: fixed-timestep loop, input, HUD and the tunables panel.
import { createState, step, STEP, DEFAULT_PARAMS, isSolid, groundLevel } from './sim.js';
import { createRenderer, LOOK_DEFAULTS } from './render.js';
import { LEVELS } from './levels.js';
import { createRig, updateRig, setRigMotion, landRig, RIG_DEFAULTS, SPIDER_RIG, STAINER_RIG } from './bug.js';
import { stepResponse } from './dynamics.js';
import { createVitals } from './vitals.js';
import { CHARACTERS, characterById } from './characters.js';

const VIEW_DEFAULTS = { zoom: 1, camLag: 0.12 };
// Body-motion presets now belong to the playable bugs (src/characters.js).
// "Robot" (the mantis) is the setup from the procedural-animation video
// (zeta 0.5, r -2: underdamped with anticipation).
const CHAR_KEY = 'biometric.character.v1';
const charRig = (ch) => ({ ...RIG_DEFAULTS, ...ch.rig, ...ch.motion });

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
  { key: 'bodyF', label: 'Frequency f', unit: 'Hz', min: 0.3, max: 10, step: 0.1, group: 'Body motion', rig: true },
  { key: 'bodyZeta', label: 'Damping ζ', unit: '', min: 0, max: 2, step: 0.05, group: 'Body motion', rig: true },
  { key: 'bodyR', label: 'Response r', unit: '', min: -3, max: 3, step: 0.1, group: 'Body motion', rig: true },
  { key: 'headF', label: 'Head lag f', unit: 'Hz', min: 0.3, max: 10, step: 0.1, group: 'Body motion', rig: true },
  { key: 'stepThreshold', label: 'Step distance', unit: 'tiles', min: 0.08, max: 0.4, step: 0.01, group: 'Legs', rig: true },
  { key: 'stepTime', label: 'Step time', unit: 's', min: 0.04, max: 0.3, step: 0.01, group: 'Legs', rig: true },
  { key: 'stepHeight', label: 'Step height', unit: 'tiles', min: 0, max: 0.35, step: 0.01, group: 'Legs', rig: true },
  { key: 'pixel', label: 'Art pixel size', unit: 'world px', min: 1, max: 4, step: 0.5, group: 'Look', look: true },
  { key: 'dither', label: 'Dither', unit: '', min: 0, max: 32, step: 1, group: 'Look', look: true },
  { key: 'darkness', label: 'Darkness', unit: '', min: 0, max: 0.85, step: 0.05, group: 'Look', look: true },
  { key: 'rain', label: 'Rain', unit: '', min: 0, max: 1, step: 0.05, group: 'Look', look: true },
  { key: 'zoom', label: 'Zoom', unit: '×', min: 0.5, max: 2.5, step: 0.05, group: 'Camera', view: true },
  { key: 'camLag', label: 'Camera lag', unit: 's', min: 0, max: 0.6, step: 0.01, group: 'Camera', view: true },
];

const STORE_KEY = 'biometric.tunables.v1';
const BEST_KEY = 'biometric.best.v1';

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
  let character = characterById(snapshot?.character ?? load(CHAR_KEY));
  // Motion tweaks from the panel are kept only for the bug they were made on.
  const rigOpts = { ...charRig(character), ...(stored.rigFor === character.id ? stored.rig : {}) };
  // What the simulation runs with: tunables plus the bug's own mechanics.
  const simParams = () => ({ ...params, ...character.params });
  // Panel values start from the chosen bug's own stats.
  const loadStats = () => Object.assign(params, DEFAULT_PARAMS, stored.params, character.params);
  loadStats();
  const look = { ...LOOK_DEFAULTS, ...stored.look };
  let best = load(BEST_KEY) ?? {};

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const renderer = createRenderer(canvas);
  let levelIndex = 0;
  let state = createState(LEVELS[levelIndex], 1, simParams());
  // Where a bug's foot may land: not on a wall, and not on ground at another
  // level than the body (no feet dangling down cliffs). Steps and ramps are fine.
  const footBlocked = (rig) => (x, y) => isSolid(state.map, Math.floor(x), Math.floor(y))
    || Math.abs(groundLevel(state.map, x, y) - groundLevel(state.map, rig.pos.x, rig.pos.y)) > 0.6;
  let rigs;
  function makeRigs() {
    const p = state.player;
    rigs = {
      player: createRig(p.x, p.y, Math.atan2(p.faceY, p.faceX), { ...rigOpts }),
      critters: new Map(), // by spider id; spiders come and go
      kind: character.kind,
      ballRadius: params.ballRadius,
    };
    renderer.resetBall();
    syncSpiderRigs();
    renderer.resetDecals(state.map);
  }
  function syncSpiderRigs() {
    const ids = new Set();
    for (const c of state.critters) {
      ids.add(c.id);
      if (!rigs.critters.has(c.id)) {
        const rig = createRig(c.x, c.y, Math.atan2(c.dirY, c.dirX) || c.id * 1.3, c.type === 'spider' ? SPIDER_RIG : STAINER_RIG);
        rig.zLevel = c.z;
        rigs.critters.set(c.id, rig);
      }
    }
    for (const id of rigs.critters.keys()) if (!ids.has(id)) rigs.critters.delete(id);
  }
  makeRigs();
  let shake = 0, vitalsFlash = 0;
  const vitals = createVitals($('vitals'));
  let started = false;

  function centreCamera() {
    const s = renderer.screenOf(state.player.x, state.player.y);
    view.camX = s.x; view.camY = s.y - 10;
  }
  function restart() {
    state = createState(LEVELS[levelIndex], (Date.now() >>> 0) || 1, simParams());
    makeRigs();
    centreCamera();
    $('win').hidden = true;
    $('dead').hidden = true;
  }

  // ---- input -------------------------------------------------------------
  const keys = new Set();
  let dashQueued = false;
  const KEYMAP = {
    ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r',
    ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
  };
  function begin() {
    if (started || menuOpen) return;
    started = true;
  }

  // ---- character select ---------------------------------------------------
  let menuOpen = true; // the game opens on the character select
  const grid = $('char-grid');
  const previews = CHARACTERS.map((ch) => {
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'char'; card.dataset.id = ch.id;
    card.innerHTML = `<canvas width="120" height="76" aria-hidden="true"></canvas>
      <span class="cname"></span><span class="clatin"></span><span class="cpreset"></span><span class="cblurb"></span>
      <span class="cstats"></span><span class="cspecial"></span>`;
    card.querySelector('.cname').textContent = ch.name;
    card.querySelector('.clatin').textContent = ch.latin;
    card.querySelector('.cpreset').textContent = `Motion: ${ch.preset}`;
    card.querySelector('.cblurb').textContent = ch.blurb;
    card.querySelector('.cspecial').textContent = ch.special;
    // Stat bars, scaled to the best value among all bugs.
    const st = { ...DEFAULT_PARAMS, ...ch.params };
    const all = CHARACTERS.map((c) => ({ ...DEFAULT_PARAMS, ...c.params }));
    const rows = [
      ['Speed', st.maxSpeed, Math.max(...all.map((a) => a.maxSpeed))],
      ['Health', st.maxHealth, Math.max(...all.map((a) => a.maxHealth))],
      ['Dash', st.dashSpeed * st.dashDuration, Math.max(...all.map((a) => a.dashSpeed * a.dashDuration))],
    ];
    const stats = card.querySelector('.cstats');
    for (const [label, v, max] of rows) {
      const row = document.createElement('span');
      row.className = 'stat-row';
      row.innerHTML = '<span class="sl"></span><span class="bar"><i></i></span><span class="sv"></span>';
      row.querySelector('.sl').textContent = label;
      row.querySelector('i').style.width = `${Math.round((v / max) * 100)}%`;
      row.querySelector('.sv').textContent = label === 'Dash' ? `${v.toFixed(1)} t` : label === 'Speed' ? `${v}` : `${v}`;
      stats.append(row);
    }
    card.addEventListener('click', () => chooseCharacter(ch.id));
    grid.append(card);
    const rig = createRig(0, 0, 0, charRig(ch));
    return { ch, card, canvas: card.querySelector('canvas'), rig, ball: ch.params.mech === 'ball' ? { x: 0, y: 0 } : null };
  });
  function markChosen() {
    for (const pv of previews) pv.card.setAttribute('aria-pressed', String(pv.ch.id === character.id));
    $('bug-btn').textContent = `Bug: ${character.name}`;
  }
  function openMenu() {
    menuOpen = true;
    $('chars').hidden = false;
    keys.clear();
    previews.find((pv) => pv.ch.id === character.id)?.card.focus();
  }
  function closeMenu() {
    menuOpen = false;
    $('chars').hidden = true;
    last = performance.now(); acc = 0;
  }
  function chooseCharacter(id) {
    const changed = id !== character.id;
    character = characterById(id);
    save(CHAR_KEY, character.id);
    if (changed) {
      Object.keys(rigOpts).forEach((k) => delete rigOpts[k]); Object.assign(rigOpts, charRig(character));
      stored.params = {}; loadStats(); persist(); buildPanel();
    }
    markChosen();
    closeMenu();
    restart();
    started = true;
  }
  // Each card shows its bug walking a small loop; the dung beetle chases its ball.
  function animatePreviews(dt, t) {
    for (const [i, pv] of previews.entries()) {
      const a = t * 0.9 + i;
      // A small loop that fits the card at preview scale.
      const r = 0.55, x = Math.cos(a) * r, y = Math.sin(a) * r;
      const vx = -Math.sin(a) * r * 0.9, vy = Math.cos(a) * r * 0.9;
      updateRig(pv.rig, Math.min(dt, 0.05), { x, y, vx, vy });
      if (pv.ball) {
        const sp = Math.hypot(vx, vy) || 1, gap = params.radius + params.ballRadius;
        pv.ball.x = pv.rig.pos.x + (vx / sp) * gap; pv.ball.y = pv.rig.pos.y + (vy / sp) * gap;
      }
      renderer.renderPreview(pv.canvas, pv.rig, pv.ch.kind, t, pv.ball);
    }
  }
  $('bug-btn').addEventListener('click', () => openMenu());
  grid.addEventListener('keydown', (e) => {
    const cards = previews.map((pv) => pv.card);
    const i = cards.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.code];
    if (move) { cards[(i + move + cards.length) % cards.length].focus(); e.preventDefault(); e.stopPropagation(); }
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('#panel')) return;
    if (menuOpen) {
      if (e.code === 'Escape' && started) closeMenu();
      return;
    }
    if (e.code === 'KeyC') { openMenu(); e.preventDefault(); return; }
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
    save(STORE_KEY, tuneData());
  }
  function tuneData() {
    const rig = {};
    for (const t of TUNABLES) if (t.rig) rig[t.key] = rigOpts[t.key];
    return { params, view: { zoom: view.zoom, camLag: view.camLag }, rig, rigFor: character.id, look };
  }
  const holder = (t) => (t.view ? view : t.rig ? rigOpts : t.look ? look : params);
  function valueOf(t) { return holder(t)[t.key]; }
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
        if (group === 'Body motion') rows.append(motionIntro());
        if (group === 'Look') rows.append(paletteRow());
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
        holder(t)[t.key] = v;
        if (t.rig) drawResponse();
        out.textContent = `${fmt(t, v)} ${t.unit}`;
        persist();
      });
      rows.append(row);
    }
    drawResponse();
  }
  // Step response of the current body settings: how the body follows when
  // the target jumps by one unit. Same maths as the game uses.
  function motionIntro() {
    const box = document.createElement('div');
    box.className = 'motion';
    box.innerHTML = `<canvas id="response" width="536" height="200" aria-label="Step response plot"></canvas>
      <p class="note">How the body catches up when its target jumps. Dashed line = target. Above it is overshoot, below zero is anticipation.</p>
      <div class="presets"></div>`;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn chip';
    b.textContent = `Reset to ${character.name} (${character.preset})`;
    b.addEventListener('click', () => { Object.assign(rigOpts, charRig(character)); persist(); buildPanel(); });
    box.querySelector('.presets').append(b);
    return box;
  }
  function drawResponse() {
    const c = document.getElementById('response');
    if (!c) return;
    const g = c.getContext('2d');
    const cs = getComputedStyle(document.documentElement);
    const W = c.width, H = c.height, pad = 12;
    const ys = stepResponse(rigOpts.bodyF, rigOpts.bodyZeta, rigOpts.bodyR, 2, 240);
    const lo = Math.min(-0.25, ...ys), hi = Math.max(1.5, ...ys);
    const Y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);
    g.clearRect(0, 0, W, H);
    g.strokeStyle = cs.getPropertyValue('--line'); g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke();
    g.setLineDash([8, 6]); g.strokeStyle = cs.getPropertyValue('--muted');
    g.beginPath(); g.moveTo(0, Y(1)); g.lineTo(W, Y(1)); g.stroke(); g.setLineDash([]);
    g.strokeStyle = cs.getPropertyValue('--ember'); g.lineWidth = 3;
    g.beginPath();
    ys.forEach((v, i) => { const x = (i / (ys.length - 1)) * W; if (i) g.lineTo(x, Y(v)); else g.moveTo(x, Y(v)); });
    g.stroke();
    g.fillStyle = cs.getPropertyValue('--muted'); g.font = '20px ' + cs.getPropertyValue('--mono');
    g.fillText('2 s', W - 40, H - 18);
  }
  function paletteRow() {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label for="t-palette">Palette</label><output></output>
      <select id="t-palette"><option value="on">Snap to the grime palette</option><option value="off">Free colours</option></select>`;
    const sel = row.querySelector('select');
    sel.value = look.palette ? 'on' : 'off';
    sel.addEventListener('change', () => { look.palette = sel.value === 'on'; persist(); });
    return row;
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
    Object.assign(rigOpts, charRig(character));
    Object.assign(look, LOOK_DEFAULTS);
    persist(); buildPanel();
    flash('Back to the spec defaults');
  });
  $('copy-tune').addEventListener('click', () => {
    const text = JSON.stringify(tuneData(), null, 2);
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
  const hudShards = $('hud-shards'), hudTime = $('hud-time'), hudDash = $('hud-dash'), hudBpm = $('hud-bpm'), hudKills = $('hud-kills'), capHp = $('cap-hp'), capCh = $('cap-ch'), hudBpmLabel = $('hud-bpm-label');
  const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
  function updateHud() {
    hudShards.textContent = `${state.collected} / ${state.shards.length}`;
    hudTime.textContent = fmtTime(state.time);
    const cd = params.dashCooldown > 0 ? 1 - state.player.dashCooldown / params.dashCooldown : 1;
    hudDash.style.setProperty('--fill', String(cd));
    const pl = state.player;
    const canDash = pl.dashCooldown <= 0 && !pl.overheated && pl.charges > 0;
    hudDash.classList.toggle('ready', canDash);
    hudDash.classList.toggle('blocked', pl.overheated || pl.charges === 0);
    hudKills.textContent = String(state.kills);
    capHp.textContent = `${pl.health} / ${params.maxHealth}`;
    capCh.textContent = `${pl.charges} / ${params.maxCharges}`;
    capCh.classList.toggle('empty', pl.charges === 0);
    const bpm = Math.round(60 + state.player.heat * 120);
    hudBpm.textContent = state.player.overheated ? 'HOT' : String(bpm);
    hudBpm.classList.toggle('hot', state.player.heat > 0.5);
    hudBpmLabel.textContent = state.player.overheated ? 'Overheat' : 'BPM';
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
  $('again-dead').addEventListener('click', () => { restart(); begin(); });
  function onDeath() {
    $('dead-time').textContent = fmtTime(state.time);
    $('dead-stats').textContent = `${state.collected} of ${state.shards.length} cells, ${state.kills} spiders killed.`;
    $('dead').hidden = false;
  }

  // The simulation reports what happened; turn it into effects here.
  const eventLog = []; // last events, readable through #debug
  function drainEvents(ix, iy) {
    for (const e of state.events) {
      eventLog.push(e); if (eventLog.length > 50) eventLog.shift();
      if (e.type === 'pickup') { if (e.big) renderer.bigBurst(e.x, e.y); else renderer.burst(e.x, e.y); }
      else if (e.type === 'kill') { renderer.splat(e.x, e.y); renderer.bloodSplatter(state.map, e.x, e.y, e.dirX, e.dirY); }
      else if (e.type === 'hit') { renderer.hitFx(ix, iy); shake = 0.25; vitalsFlash = 0.2; }
      else if (e.type === 'land') {
        renderer.dust(e.x, e.y, groundLevel(state.map, e.x, e.y), e.height);
        const rig = e.who === 'player' ? rigs.player : rigs.critters.get(e.who);
        if (rig) landRig(rig, e.height);
        if (e.who === 'player' && e.height >= 1.5) shake = Math.max(shake, 0.15);
      }
      else if (e.type === 'cocoon') renderer.cocoonBurst(e.x, e.y, groundLevel(state.map, e.x, e.y));
      else if (e.type === 'shoot') renderer.muzzle(e.x, e.y, groundLevel(state.map, e.x, e.y));
      else if (e.type === 'webSplat') renderer.webSplat(e.x, e.y, e.z);
      else if (e.type === 'webTorn') renderer.webTorn();
      else if (e.type === 'webbed') shake = Math.max(shake, 0.08);
      else if (e.type === 'spawn') renderer.ventPuff({ x: e.x, y: e.y });
      else if (e.type === 'corpse') renderer.bakeHusk(state.map, e.x, e.y);
      else if (e.type === 'win') onWin();
      else if (e.type === 'death') onDeath();
    }
    state.events.length = 0;
  }

  markChosen();

  // ---- loop --------------------------------------------------------------
  function resize() { renderer.resize(); }
  window.addEventListener('resize', resize);
  resize();
  buildPanel();
  drawResponse();
  centreCamera();

  let last = performance.now();
  let acc = 0;
  let clock = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    clock += dt;
    if (menuOpen) animatePreviews(dt, clock);
    if (started && !menuOpen) {
      acc += dt;
      let input = readInput();
      const sp = simParams();
      while (acc >= STEP) {
        step(state, input, sp);
        input = { ...input, dash: false }; // a press counts once
        acc -= STEP;
      }
    }
    view.alpha = started ? acc / STEP : 1;
    const p = state.player;
    const ix = p.px + (p.x - p.px) * view.alpha, iy = p.py + (p.y - p.py) * view.alpha;
    drainEvents(ix, iy);
    syncSpiderRigs();
    renderer.updateFx(dt, p, ix, iy, rigs.player);
    // Animation runs on real frame time; the follower clamps itself on long frames.
    const adt = Math.min(dt, 0.1);
    // Biometrics drive motion: a hot core makes the body twitchier.
    setRigMotion(rigs.player, {
      ...rigOpts,
      bodyF: rigOpts.bodyF * (1 + 0.8 * p.heat),
      bodyZeta: rigOpts.bodyZeta * (1 - 0.6 * p.heat),
    });
    // Heights come from the simulation, interpolated like positions.
    const lerpZ = (e) => (e.pz ?? e.z) + (e.z - (e.pz ?? e.z)) * view.alpha;
    rigs.player.zLevel = lerpZ(p);
    updateRig(rigs.player, adt, { x: ix, y: iy, vx: p.vx, vy: p.vy, air: p.air }, footBlocked(rigs.player));
    for (const c of state.critters) {
      const rig = rigs.critters.get(c.id);
      rig.zLevel = lerpZ(c);
      if (!c.alive) continue; // corpses stay where they fell
      const cx = c.px + (c.x - c.px) * view.alpha, cy = c.py + (c.y - c.py) * view.alpha;
      updateRig(rig, adt, { x: cx, y: cy, vx: c.vx, vy: c.vy, air: c.air }, footBlocked(rig));
    }
    vitalsFlash = Math.max(0, vitalsFlash - dt);
    vitals.draw({
      health: p.health, maxHealth: params.maxHealth, charges: p.charges, maxCharges: params.maxCharges,
      bpm: 60 + p.heat * 120, overheated: p.overheated, flash: vitalsFlash, t: clock,
    });
    // Camera eases toward the player (at its real height, also mid-fall).
    const target = renderer.screenOf(ix, iy, rigs.player.zLevel);
    const k = view.camLag > 0 ? 1 - Math.exp(-dt / view.camLag) : 1;
    view.camX += (target.x - view.camX) * k;
    view.camY += (target.y - 10 - view.camY) * k;
    const fit = Math.min(renderer.size.w, renderer.size.h) / 560;
    shake = Math.max(0, shake - dt);
    const jolt = shake > 0 ? Math.sin(clock * 90) * 4 * (shake / 0.25) : 0;
    renderer.draw(state, { ...view, camX: view.camX + jolt, zoom: view.zoom * Math.min(1.6, Math.max(0.75, fit)) }, rigs, clock, look, dt);
    updateHud();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.claude?.hot?.snapshot?.(() => ({ tune: tuneData(), character: character.id }));
  // Test hook: open the page with #debug to reach the live state from a script.
  if (location.hash === '#debug') window.biometricDebug = { get state() { return state; }, params, look, view, events: eventLog };
}

const hot = window.claude?.hot;
if (hot?.ready) hot.ready(start); else start(hot?.data ?? {});
