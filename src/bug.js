// Procedural bug rig: the body follows the simulated position through a
// second-order follower, six legs keep their feet planted on the ground and
// step in a tripod gait, two-bone IK places the knees. Pure: no DOM, no
// randomness. Render code reads the rig; the simulation never does.
// Behaviour and numbers: docs/SPEC.md, "Procedural motion".
import { createFollower, follow, setMotion, resetFollower } from './dynamics.js';

export const RIG_DEFAULTS = {
  bodyF: 3, bodyZeta: 0.5, bodyR: 1, // body follow
  turnF: 2.5, turnZeta: 1, turnR: 0, // heading
  headF: 1.6, headZeta: 0.6, headR: 0, // head lags the body (secondary motion)
  bodyHeight: 0.22,
  hipSide: 0.1, hipAlong: 0.15,
  footSide: 0.36, footAlong: 0.24,
  thigh: 0.28, shin: 0.36,
  stepThreshold: 0.2,
  stepTime: 0.1,
  stepHeight: 0.14,
  stepLead: 0.8, // how far ahead (in step times) a foot aims while moving
  scale: 1, // 1 = player size; smaller for little critters
  legs: 6, // 4 (mantis), 6 (insect, tripod gait) or 8 (spider, groups of four)
  neck: 0.27, // how far ahead of the body the head sits
};

// Spiders: eight long legs, low wide stance, quick small steps.
export const SPIDER_RIG = {
  ...RIG_DEFAULTS, legs: 8, scale: 0.6,
  bodyF: 4, bodyZeta: 0.8, bodyR: 0, headF: 3,
  bodyHeight: 0.2, hipSide: 0.08, hipAlong: 0.07,
  footSide: 0.52, footAlong: 0.3, thigh: 0.36, shin: 0.42,
  stepThreshold: 0.22, stepTime: 0.05, stepHeight: 0.16,
};

// Leg layouts. Neighbouring legs on a side, and the same leg across the
// body, are always in different groups, so the body stays supported.
const LEG_LAYOUT_6 = [
  { side: -1, along: 1, group: 0 }, { side: 1, along: 1, group: 1 },
  { side: -1, along: 0, group: 1 }, { side: 1, along: 0, group: 0 },
  { side: -1, along: -1, group: 0 }, { side: 1, along: -1, group: 1 },
];
// Four walking legs (a mantis walks on its middle and hind pairs).
const LEG_LAYOUT_4 = [
  { side: -1, along: 0, group: 0 }, { side: 1, along: 0, group: 1 },
  { side: -1, along: -1, group: 1 }, { side: 1, along: -1, group: 0 },
];
const LEG_LAYOUT_8 = [1.15, 0.4, -0.4, -1.15].flatMap((along, i) => [
  { side: -1, along, group: i % 2 }, { side: 1, along, group: (i + 1) % 2 },
]);

export function rigMotion(o) {
  return {
    body: [o.bodyF, o.bodyZeta, o.bodyR],
    turn: [o.turnF, o.turnZeta, o.turnR],
    head: [o.headF, o.headZeta, o.headR],
  };
}

export function createRig(x, y, heading = Math.PI / 4, opts = RIG_DEFAULTS) {
  const m = rigMotion(opts);
  const rig = {
    opts,
    body: createFollower([x, y], ...m.body),
    turn: createFollower(heading, ...m.turn),
    head: createFollower([x, y], ...m.head),
    targetHeading: heading,
    pos: { x, y }, heading, headPos: { x, y },
    legs: (opts.legs === 8 ? LEG_LAYOUT_8 : opts.legs === 4 ? LEG_LAYOUT_4 : LEG_LAYOUT_6).map((l) => ({ ...l, foot: { x, y }, from: { x, y }, t: 1, lift: 0 })),
    vel: { x: 0, y: 0 },
    time: 0,
  };
  placeFeet(rig);
  return rig;
}

export function setRigMotion(rig, opts) {
  const m = rigMotion(opts);
  setMotion(rig.body, ...m.body);
  setMotion(rig.turn, ...m.turn);
  setMotion(rig.head, ...m.head);
  rig.opts = opts;
}

function frame(rig) {
  const c = Math.cos(rig.heading), s = Math.sin(rig.heading);
  return { fx: c, fy: s, rx: -s, ry: c };
}

export function hipOf(rig, leg) {
  const o = rig.opts, k = o.scale, F = frame(rig);
  const a = leg.along * o.hipAlong * k, sd = leg.side * o.hipSide * k;
  return { x: rig.pos.x + F.fx * a + F.rx * sd, y: rig.pos.y + F.fy * a + F.ry * sd, z: o.bodyHeight * k };
}

function restOf(rig, leg) {
  const o = rig.opts, k = o.scale, F = frame(rig);
  const a = leg.along * o.footAlong * k, sd = leg.side * o.footSide * k;
  const lead = o.stepTime * o.stepLead;
  return {
    x: rig.pos.x + F.fx * a + F.rx * sd + rig.vel.x * lead,
    y: rig.pos.y + F.fy * a + F.ry * sd + rig.vel.y * lead,
  };
}

// Pull a foot target back toward the body until it is not on a wall.
function safeTarget(rig, p, blocked) {
  if (!blocked) return p;
  let q = p;
  for (let i = 0; i < 6 && blocked(q.x, q.y); i++) {
    q = { x: (q.x + rig.pos.x) / 2, y: (q.y + rig.pos.y) / 2 };
  }
  return q;
}

export function placeFeet(rig, blocked) {
  for (const leg of rig.legs) {
    const r = safeTarget(rig, restOf(rig, leg), blocked);
    leg.foot = { ...r }; leg.from = { ...r }; leg.t = 1; leg.lift = 0;
  }
}

export function snapRig(rig, x, y, heading = rig.heading, blocked) {
  resetFollower(rig.body, [x, y]);
  resetFollower(rig.head, [x, y]);
  resetFollower(rig.turn, heading);
  rig.targetHeading = heading;
  rig.pos = { x, y }; rig.heading = heading; rig.headPos = { x, y };
  rig.vel = { x: 0, y: 0 };
  placeFeet(rig, blocked);
}

// target: simulated position and velocity. blocked(x, y): true on walls.
export function updateRig(rig, dt, target, blocked) {
  if (dt <= 0) return rig;
  const o = rig.opts;
  rig.time += dt;
  const prev = rig.pos;
  const [bx, by] = follow(rig.body, dt, [target.x, target.y]);
  rig.pos = { x: bx, y: by };
  rig.vel = { x: (bx - prev.x) / dt, y: (by - prev.y) / dt };

  const speed = Math.hypot(target.vx, target.vy);
  if (speed > 0.3) {
    // Unwrap so the follower always turns the short way round.
    const want = Math.atan2(target.vy, target.vx);
    let d = want - rig.targetHeading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    rig.targetHeading += d;
  }
  rig.heading = follow(rig.turn, dt, rig.targetHeading);

  const F = frame(rig);
  const neck = (o.neck ?? 0.27) * o.scale;
  const [hx, hy] = follow(rig.head, dt, [bx + F.fx * neck, by + F.fy * neck]);
  rig.headPos = { x: hx, y: hy };

  // Snap feet that fell hopelessly behind (respawn, very long frame).
  const snap = (o.thigh + o.shin) * o.scale * 2.5;
  for (const leg of rig.legs) {
    const r = restOf(rig, leg);
    if (Math.hypot(leg.foot.x - r.x, leg.foot.y - r.y) > snap) { placeFeet(rig, blocked); break; }
  }

  // Airborne feet travel toward their (moving) rest spot along an arc.
  for (const leg of rig.legs) {
    if (leg.t >= 1) continue;
    leg.t = Math.min(1, leg.t + dt / o.stepTime);
    const to = safeTarget(rig, restOf(rig, leg), blocked);
    const e = leg.t * leg.t * (3 - 2 * leg.t);
    leg.foot = { x: leg.from.x + (to.x - leg.from.x) * e, y: leg.from.y + (to.y - leg.from.y) * e };
    leg.lift = Math.sin(Math.PI * leg.t) * o.stepHeight * o.scale;
    if (leg.t >= 1) leg.lift = 0;
  }

  // Tripod gait: a group lifts only while the other group is fully planted.
  const airborne = [0, 1].map((g) => rig.legs.some((l) => l.group === g && l.t < 1));
  const need = [0, 0];
  for (const leg of rig.legs) {
    if (leg.t < 1) continue;
    const r = restOf(rig, leg);
    need[leg.group] = Math.max(need[leg.group], Math.hypot(leg.foot.x - r.x, leg.foot.y - r.y));
  }
  const thr = o.stepThreshold * o.scale;
  const g = need[0] >= need[1] ? 0 : 1;
  for (const grp of [g, 1 - g]) {
    if (need[grp] <= thr || airborne[1 - grp] || airborne[grp]) continue;
    for (const leg of rig.legs) {
      if (leg.group !== grp) continue;
      leg.from = { ...leg.foot }; leg.t = 0;
    }
    airborne[grp] = true;
    break;
  }
  return rig;
}

// Two-bone IK. Returns the knee, bent upward, in the vertical plane through
// hip and foot. If the foot is out of reach the leg points straight at it.
export function legIK(hip, foot, a, b) {
  let dx = foot.x - hip.x, dy = foot.y - hip.y, dz = foot.z - hip.z;
  const dist = Math.hypot(dx, dy, dz) || 1e-9;
  dx /= dist; dy /= dist; dz /= dist;
  const d = Math.min(dist, a + b - 1e-6);
  const along = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - along * along));
  // Up direction perpendicular to the hip-foot line.
  let ux = -dx * dz, uy = -dy * dz, uz = 1 - dz * dz;
  const ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; } else { ux /= ul; uy /= ul; uz /= ul; }
  return {
    x: hip.x + dx * along + ux * h,
    y: hip.y + dy * along + uy * h,
    z: hip.z + dz * along + uz * h,
  };
}
