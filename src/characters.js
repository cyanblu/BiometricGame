// Playable bugs. Pure data: rig proportions (src/bug.js), body-motion
// personality (f / zeta / r, see src/dynamics.js), how the renderer draws
// them (`kind`), gameplay stats (`params`, merged over the sim's
// DEFAULT_PARAMS) and a one-line `special`. Each motion preset belongs to one bug.

export const CHARACTERS = [
  {
    id: 'cowboy',
    name: 'Cowboy beetle',
    latin: 'Chondropyga dorsalis',
    preset: 'Default',
    blurb: 'The all-rounder. A steady six-legged trot with a little bounce.',
    special: 'No weaknesses, no tricks.',
    kind: 'cowboy',
    motion: { bodyF: 3, bodyZeta: 0.5, bodyR: 1, headF: 1.6 },
    rig: { legs: 6, scale: 1 },
    params: {},
  },
  {
    id: 'stag',
    name: 'Stag beetle',
    latin: 'Lucanus cervus · Hirschkäfer',
    preset: 'Heavy',
    blurb: 'Huge antlers, heavy body. Leans into every turn, never wobbles.',
    special: 'Tough: 14 health, barely knocked back. Slow, and dashes run hot.',
    kind: 'stag',
    motion: { bodyF: 1.2, bodyZeta: 1.2, bodyR: 0, headF: 1 },
    rig: {
      legs: 6, scale: 1.1, bodyHeight: 0.24, hipAlong: 0.16, footSide: 0.4, footAlong: 0.28,
      thigh: 0.3, shin: 0.38, stepTime: 0.12, neck: 0.3,
    },
    params: { maxSpeed: 3.6, accel: 18, decel: 22, dashSpeed: 11, dashHeat: 0.4, maxHealth: 14, knockback: 3, radius: 0.34 },
  },
  {
    id: 'jumper',
    name: 'Jumping spider',
    latin: 'Salticidae · Springspinne',
    preset: 'Snappy',
    blurb: 'Eight quick legs and big glowing eyes. Goes exactly where you point.',
    special: 'Long leaping dashes with a short cooldown. Fragile: 7 health.',
    kind: 'jumper',
    motion: { bodyF: 6, bodyZeta: 1, bodyR: 0, headF: 5 },
    rig: {
      legs: 8, scale: 0.9, bodyHeight: 0.2, hipSide: 0.08, hipAlong: 0.07, footSide: 0.5, footAlong: 0.3,
      thigh: 0.34, shin: 0.4, stepThreshold: 0.22, stepTime: 0.06, stepHeight: 0.16, neck: 0.2,
    },
    params: { maxSpeed: 5.2, accel: 60, decel: 60, dashSpeed: 16, dashDuration: 0.16, dashCooldown: 0.4, maxHealth: 7, radius: 0.27 },
  },
  {
    id: 'harvestman',
    name: 'Daddy longlegs',
    latin: 'Opiliones · Weberknecht',
    preset: 'Springy',
    blurb: 'A tiny body slung between eight absurd legs. Bounces and sways.',
    special: 'Fast but floaty. Never stunned by falls; webs barely hold it.',
    kind: 'harvestman',
    motion: { bodyF: 2.5, bodyZeta: 0.25, bodyR: 2, headF: 2.5 },
    rig: {
      legs: 8, scale: 1, bodyHeight: 0.48, hipSide: 0.04, hipAlong: 0.03, footSide: 0.9, footAlong: 0.55,
      thigh: 0.62, shin: 0.8, stepThreshold: 0.38, stepTime: 0.1, stepHeight: 0.3, neck: 0.05,
    },
    params: { maxSpeed: 5.4, accel: 14, decel: 9, maxHealth: 8, radius: 0.24, fallStunHeight: 99, webSlow: 0.75, webDuration: 1.2 },
  },
  {
    id: 'mantis',
    name: 'Praying mantis',
    latin: 'Mantis religiosa · Gottesanbeterin',
    preset: 'Robot',
    blurb: 'Walks on four legs, arms folded. Rears back before every move.',
    special: 'Long reach: its dash strikes from much further away.',
    kind: 'mantis',
    motion: { bodyF: 2, bodyZeta: 0.5, bodyR: -2, headF: 1.6 },
    rig: {
      legs: 4, scale: 1.1, bodyHeight: 0.26, hipSide: 0.06, hipAlong: 0.12, footSide: 0.38, footAlong: 0.32,
      thigh: 0.32, shin: 0.4, stepTime: 0.1, neck: 0.42,
    },
    params: { maxSpeed: 4.2, dashSpeed: 14, killMargin: 0.45, maxHealth: 9 },
  },
  {
    id: 'dung',
    name: 'Dung beetle',
    latin: 'Scarabaeus sacer · Pillendreher',
    preset: 'Own: the ball',
    blurb: 'Pushes a ball that keeps rolling. Kick it with a dash; a fast ball flattens spiders.',
    special: 'The ball: momentum, kicks, squashes bugs and breaks cocoons. 12 health.',
    kind: 'dung',
    motion: { bodyF: 3, bodyZeta: 0.7, bodyR: 0.5, headF: 2 },
    rig: { legs: 6, scale: 0.9, bodyHeight: 0.18, neck: 0.2 },
    params: { mech: 'ball', maxSpeed: 4, maxHealth: 12 },
  },
];

export const characterById = (id) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
