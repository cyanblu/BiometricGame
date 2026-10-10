// Playable bugs. Pure data: rig proportions (src/bug.js), body-motion
// personality (f / zeta / r, see src/dynamics.js), how the renderer draws
// them (`kind`) and any gameplay overrides (`params`, merged over the sim's
// DEFAULT_PARAMS). Each motion preset belongs to one bug.

export const CHARACTERS = [
  {
    id: 'cowboy',
    name: 'Cowboy beetle',
    latin: 'Chondropyga dorsalis',
    preset: 'Default',
    blurb: 'The all-rounder. A steady six-legged trot with a little bounce.',
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
    kind: 'stag',
    motion: { bodyF: 1.2, bodyZeta: 1.2, bodyR: 0, headF: 1 },
    rig: {
      legs: 6, scale: 1.1, bodyHeight: 0.24, hipAlong: 0.16, footSide: 0.4, footAlong: 0.28,
      thigh: 0.3, shin: 0.38, stepTime: 0.12, neck: 0.3,
    },
    params: {},
  },
  {
    id: 'jumper',
    name: 'Jumping spider',
    latin: 'Salticidae · Springspinne',
    preset: 'Snappy',
    blurb: 'Eight quick legs and big glowing eyes. Goes exactly where you point.',
    kind: 'jumper',
    motion: { bodyF: 6, bodyZeta: 1, bodyR: 0, headF: 5 },
    rig: {
      legs: 8, scale: 0.9, bodyHeight: 0.2, hipSide: 0.08, hipAlong: 0.07, footSide: 0.5, footAlong: 0.3,
      thigh: 0.34, shin: 0.4, stepThreshold: 0.22, stepTime: 0.06, stepHeight: 0.16, neck: 0.2,
    },
    params: {},
  },
  {
    id: 'harvestman',
    name: 'Daddy longlegs',
    latin: 'Opiliones · Weberknecht',
    preset: 'Springy',
    blurb: 'A tiny body slung between eight absurd legs. Bounces and sways.',
    kind: 'harvestman',
    motion: { bodyF: 2.5, bodyZeta: 0.25, bodyR: 2, headF: 2.5 },
    rig: {
      legs: 8, scale: 1, bodyHeight: 0.48, hipSide: 0.04, hipAlong: 0.03, footSide: 0.9, footAlong: 0.55,
      thigh: 0.62, shin: 0.8, stepThreshold: 0.38, stepTime: 0.1, stepHeight: 0.3, neck: 0.05,
    },
    params: {},
  },
  {
    id: 'mantis',
    name: 'Praying mantis',
    latin: 'Mantis religiosa · Gottesanbeterin',
    preset: 'Robot',
    blurb: 'Walks on four legs, arms folded. Rears back before every move.',
    kind: 'mantis',
    motion: { bodyF: 2, bodyZeta: 0.5, bodyR: -2, headF: 1.6 },
    rig: {
      legs: 4, scale: 1.1, bodyHeight: 0.26, hipSide: 0.06, hipAlong: 0.12, footSide: 0.38, footAlong: 0.32,
      thigh: 0.32, shin: 0.4, stepTime: 0.1, neck: 0.42,
    },
    params: {},
  },
  {
    id: 'dung',
    name: 'Dung beetle',
    latin: 'Scarabaeus sacer · Pillendreher',
    preset: 'Own: the ball',
    blurb: 'Pushes a ball that keeps rolling. Kick it with a dash; a fast ball flattens spiders.',
    kind: 'dung',
    motion: { bodyF: 3, bodyZeta: 0.7, bodyR: 0.5, headF: 2 },
    rig: { legs: 6, scale: 0.9, bodyHeight: 0.18, neck: 0.2 },
    params: { mech: 'ball' },
  },
];

export const characterById = (id) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
