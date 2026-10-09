# Shardfield behaviour spec (v0.3)

Premise: you control a small mechanical bug in a world of living bugs. The
bug's vital signs (biometrics) are part of play and show up in how it moves.
Setting: a grimy, rain-soaked industrial ruin with failing electrics (think
Rain World). The pickups are small battery cells.

Working title. This file is the reference the code is tested against. When a
number changes here, change `DEFAULT_PARAMS` in `src/sim.js` and the tests in
`test/sim.test.js` with it.

## Coordinates

- The world is a grid of square tiles. One world unit = one tile edge.
- `x` grows toward the bottom-right of the screen, `y` toward the bottom-left.
- Projection (2:1 isometric, at zoom 1):
  `screenX = (x - y) * 32`, `screenY = (x + y) * 16`.
- Simulation runs at a fixed 60 steps per second. Rendering interpolates
  between the last two steps.

## Player

| Property | Default | Unit |
|---|---|---|
| Radius (collision circle) | 0.30 | tiles |
| Top speed | 4.5 | tiles/s |
| Acceleration while input held | 30 | tiles/s² |
| Deceleration with no input | 35 | tiles/s² |
| Dash speed | 13 | tiles/s |
| Dash duration | 0.14 | s |
| Dash cooldown (from dash start) | 0.55 | s |
| Dash input buffer | 0.10 | s |

### Movement

1. Input is a 2D stick or keys, read in **screen space**. Pressing "up" moves
   the player up the screen.
2. Diagonal mode `screen` (default): the world direction is the one whose
   projection points exactly where the input points. Mode `grid`: the input is
   rotated 45° onto the tile axes, so diagonals run along tile edges.
3. The world direction is normalised, then scaled by stick magnitude (max 1).
4. Velocity moves toward `direction × top speed` by at most
   `acceleration × dt` per step. With no input it moves toward zero by at most
   `deceleration × dt`.
   - From rest, top speed is reached after `4.5 / 30 = 0.15 s`.
   - From top speed, the player stops after `4.5 / 35 ≈ 0.13 s`.

### Dash

1. A dash press is remembered for the buffer window (0.10 s). If the dash
   becomes available inside that window, it fires then.
2. Dash direction is the current input direction, or the facing direction
   when there is no input.
3. During the dash, velocity is fixed at `dash direction × dash speed` and
   input is ignored. Distance ≈ `13 × 0.14 = 1.82` tiles in open space.
4. When the dash ends, velocity becomes `dash direction × top speed`, so
   the player keeps moving instead of stopping dead.
5. Cooldown counts from dash start. A second dash cannot start until 0.55 s
   after the first one started.

### Collision

1. Walls are full tiles. Everything outside the map counts as wall.
2. The player circle never overlaps a wall at the end of a step.
3. Movement is split into sub-steps no longer than half the radius, so a dash
   cannot pass through a one-tile wall.
4. On contact, the velocity component into the wall is removed; the
   component along the wall is kept (the player slides).

## Core heat (biometrics)

| Property | Default | Unit |
|---|---|---|
| Heat added per dash | 0.34 | of 1 |
| Cooling | 0.30 | per s |
| Overheat ends at | 0.35 | heat |
| Top speed while overheated | × 0.65 | |

1. Heat lives in the simulation (`player.heat`, 0 to 1, capped at 1).
2. Pulse shown in the HUD and on the bug's back light: `60 + 120 × heat` BPM.
   The light turns from teal to red above heat 0.5.
3. Overheat: when heat reaches 1 the bug overheats. While overheated it
   cannot dash and its top speed is multiplied by 0.65. It stays overheated
   until heat has cooled to 0.35 (about 2.2 s). At the defaults, dashing on
   every cooldown overheats on the 5th dash.
4. Animation: body frequency is multiplied by `1 + 0.8 × heat` and body
   damping by `1 − 0.6 × heat`, so a hot bug moves twitchier and wobblier.
   Above heat 0.6 it steams and sparks; overheated, its back light stutters
   and the HUD shows HOT / Overheat and a red dash bar.

## Procedural motion

Animation is separate from the simulation and never feeds back into it.

### Follower (`src/dynamics.js`)

Second-order system `y + k1·y' + k2·y'' = x + k3·x'` with
`k1 = ζ/(πf)`, `k2 = 1/(2πf)²`, `k3 = rζ/(2πf)`:

- `f` (Hz): how fast it responds.
- `ζ`: 0 rings forever, below 1 overshoots, 1 and above settles without overshoot.
- `r`: below 0 anticipates (moves away first), 0 eases in, above 1 overshoots at the start.

Integrated with semi-implicit Euler. `k2` is raised to at least
`max(T²/2 + T·k1/2, T·k1)` for frame time `T`, so long frames cannot make it
blow up or jitter.

### Bug rig (`src/bug.js`)

| Property | Player default | Unit |
|---|---|---|
| Body follow f / ζ / r | 3 / 0.5 / 1 | |
| Heading f / ζ / r | 2.5 / 1 / 0 | |
| Head follow f / ζ / r | 1.6 / 0.6 / 0 | |
| Thigh / shin length | 0.28 / 0.36 | tiles |
| Step distance | 0.20 | tiles |
| Step time | 0.10 | s |
| Step height | 0.14 | tiles |

1. The body follows the simulated position through a follower; the head
   follows a point in front of the body with a slower follower (secondary motion).
2. Six legs, tripod gait: front-left, middle-right and back-left step
   together, then the other three. A group lifts only when the other group is
   fully planted, so at most three feet are ever in the air.
3. A group lifts when one of its feet is further than the step distance from
   its rest spot. The rest spot leads ahead by `velocity × step time × 0.8`.
4. Feet never land on walls; the target is pulled toward the body instead.
5. Two-bone IK, knee bent upward. At walking and top speed feet stay within
   leg reach on at least 98 % of frames (they may overstretch during a dash).
6. Presets in the panel: Default, Robot (2 / 0.5 / −2, from the
   procedural-animation video), Snappy, Springy, Heavy.

## Critters

| Property | Default | Unit |
|---|---|---|
| Radius | 0.18 | tiles |
| Wander speed | 1.1 | tiles/s |
| Flee speed | 3.2 | tiles/s |
| Fear radius | 2.2 | tiles |

1. Spawn at `b` in the level map. Movement is in the simulation, using a
   seeded PRNG stored in the state, so a run is reproducible from its seed.
2. Every 0.8–2.6 s a critter picks a new random heading, or pauses (30 %).
3. Inside the fear radius it runs straight away from the player, and keeps
   running for 0.4 s after leaving it.
4. Same wall collision as the player. A critter pressed against a wall picks
   a new direction.
5. Drawn with the same rig at 0.55 scale.

## Battery cells

(Called `shards` in the code.)

1. Picked up when the player centre is within `radius + 0.35` of the cell.
2. When every shard is collected the run is won and the timer stops.
3. `R` restarts the level with the current tunables.

## Look

1. The world is drawn into an offscreen canvas at `1 / pixel size` of the
   screen resolution (default pixel size 3), lit, then scaled up without
   smoothing. The camera snaps to whole low-res pixels.
2. Every pixel is then snapped to the fixed palette in `src/pixel.js`
   (`COLORS`), with 4×4 ordered dithering (default strength 6). All palette
   colours stay reachable (tested).
3. Lighting: the frame is darkened (default 0.55) except around lights (wall
   lamps, some of which flicker; battery glow and arcs; the bug's back light,
   head lamp and body glow), plus a coloured additive glow.
4. Rain in screen space, drawn before lighting so it shows near lights.
5. Look settings are tunable: pixel size, dither, darkness, rain, palette on/off.

## Not decided yet

- What the goal is beyond collecting cells (do cells charge or cool the bug?).
- How the player interacts with other bugs beyond scaring them.
- Art direction beyond placeholder shapes.
