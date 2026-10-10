# Biometric behaviour spec (v0.8)

Premise: you control a small mechanical bug in a world of living bugs. The
bug's vital signs (biometrics) are part of play and show up in how it moves.
Setting: a grimy, rain-soaked industrial ruin with failing electrics (think
Rain World). The pickups are small battery cells.

This file is the reference the code is tested against. When a
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
| Charges at start / max | 10 / 30 | |
| Health | 10 | |

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

0. Every dash spends one **charge**. You start with 10, the most you can hold
   is 30. A small battery cell adds 3, a big red battery adds 9 (capped at 30;
   anything over the cap is lost). No charge, no dash.
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

### Terrain levels

| Property | Value |
|---|---|
| Height of one level (drawn) | 24 world px (a wall is 34) |
| Surfaces meet within | 0.12 levels |
| Pickups, hits and kills reach | 0.5 levels up or down |

1. Every tile has a level (`heights` layer of the map: `0`–`9`). Ramps
   (`>` `<` `v` `^`) and stairs (`E` `W` `S` `N`) rise toward +x, −x, +y, −y.
   A slope starts at the level of the tile on its low side and rises by one
   level across the tile. Stairs move exactly like ramps; only the look differs.
2. Height is continuous on slopes: walking up one changes height smoothly.
3. You can't walk or dash **up** a cliff; up only goes by ramps and stairs.
   You **can** step, run or dash **off** a ledge (or off the side of a slope)
   and fall to the floor below. This applies to every entity: player,
   stainers, spiders and the dung ball.
4. Rule: an entity touching another tile at point *c* is blocked when that
   tile is a wall, or when that tile's surface at *c* is more than 0.12 levels
   higher than the entity. On the ground "the entity's height" is its own
   tile's surface at *c* (which lets a 0.3-radius body leave the top of a
   ramp); in the air, or once its centre is past the edge, it is its height.
5. Falling: past a drop of more than 0.15 levels (more than walking down a
   ramp), the entity is airborne. Gravity 30 levels/s² (one level takes
   about 0.26 s). In the air the player keeps its momentum and has 35 % of
   its acceleration for steering; dashing still works. After a fall the
   entity is pushed off any cliff face it ended up beside.
6. Landing from 0.5 levels or more reports a `land` event (dust, body squash).
   Landing from 1.5 levels or more stuns the player for 0.25 s.
7. Animation: in the air legs splay and flail, the body hangs on its spring;
   the shadow stays on the floor below, shrinking with height; landing kicks
   the body's vertical spring (it dips and bounces back). Camera follows the
   real height.
8. Batteries, hits and dash kills only count within 0.5 levels.
9. Bugs' feet land on the ground under them (they reach down steps), never on
   ground more than 0.6 levels away from the body.
10. Tested: every slope's low and high side are open, the arena uses at least
    three levels, every battery, vent and cocoon is reachable from the spawn,
    and from every reachable tile you can get back to the spawn (no traps).

### Collision

1. Walls are full tiles. Everything outside the map counts as wall.
2. The player circle never overlaps a wall at the end of a step.
3. Movement is split into sub-steps no longer than half the radius, so a dash
   cannot pass through a one-tile wall.
4. On contact, the velocity component into the wall is removed; the
   component along the wall is kept (the player slides).

## Characters

Chosen in a separate menu that opens first (and with `C` or the Bug button;
choosing restarts the run). Data in `src/characters.js`. Every bug carries
the same biometric implant (heartbeat light, pulse, heat). The cards show
speed, health and dash-distance bars and a one-line special.

| Bug | Top speed | Health | Dash (speed × time) | Other |
|---|---|---|---|---|
| Cowboy beetle | 4.5 | 10 | 13 × 0.14 | baseline |
| Stag beetle | 3.6 (accel 18) | 14 | 11 × 0.14 | knockback 3, radius 0.34, dash heat 0.4 |
| Jumping spider | 5.2 (accel 60) | 7 | 16 × 0.16 | dash cooldown 0.4, radius 0.27 |
| Daddy longlegs | 5.4 (accel 14, decel 9) | 8 | 13 × 0.14 | no fall stun, webs slow to 75 % for 1.2 s, radius 0.24 |
| Praying mantis | 4.2 | 9 | 14 × 0.14 | dash kill reach 0.45 |
| Dung beetle | 4 | 12 | (kicks the ball) | ball mechanics |

| Bug | Motion preset (f / ζ / r) | Legs | Look |
|---|---|---|---|
| Cowboy beetle (*Chondropyga dorsalis*) | Default 3 / 0.5 / 1 | 6 | dark chafer shell, cream margins and mid-line |
| Stag beetle (*Lucanus cervus*, Hirschkäfer) | Heavy 1.2 / 1.2 / 0 | 6 | chestnut wing cases, black thorax, antlers |
| Jumping spider (Salticidae, Springspinne) | Snappy 6 / 1 / 0 | 8 | striped abdomen, four big glowing front eyes |
| Daddy longlegs (Opiliones, Weberknecht) | Springy 2.5 / 0.25 / 2 | 8 | tiny high body, very long legs |
| Praying mantis (*Mantis religiosa*, Gottesanbeterin) | Robot 2 / 0.5 / −2 | 4 | long green body, folded raptorial arms |
| Dung beetle (*Scarabaeus sacer*, Pillendreher) | own: 3 / 0.7 / 0.5 | 6 | glossy black, shovel head, pushes a ball |

Tested: each preset belongs to exactly one bug; no two bugs share their
stats; the stated strengths and weaknesses hold; every bug's gait keeps at
least half its feet down and its feet within reach at walking and top speed.

### Dung beetle: the ball

| Property | Default | Unit |
|---|---|---|
| Ball radius | 0.32 | tiles |
| Push acceleration | 7 | tiles/s² |
| Fastest push | 6.5 | tiles/s |
| Rolling friction | 1.6 | tiles/s² |
| Bounce (speed kept) | 0.45 | |
| Kick speed | 9 | tiles/s |
| Squash speed | 3 | tiles/s |
| Beetle repositioning speed | 6 | tiles/s |

0. **Away from the ball** (more than 0.6 tiles beyond touching, on another
   floor, or either of them in the air) you steer the beetle like any bug,
   at its normal speed; e.g. walk it up the stairs to a ball left on a
   platform. Let go and it finds its own way back: shortest walk over the
   same walk-and-drop rules (`findPath`), tile by tile. Back at the ball,
   pushing resumes.
1. At the ball, the beetle runs to the spot behind it, opposite the direction you
   steer, and pushes when it touches the ball from behind (within 0.12 tiles,
   facing the push within about 53°).
2. The ball accelerates slowly, keeps rolling when you let go and slows by
   friction; it bounces off walls and cliffs, keeping 45 % of the blocked
   speed. Beetle and ball never overlap.
3. A dash while touching the ball kicks it (one charge, heat as usual): the
   ball goes to 9 tiles/s away from the beetle; the beetle stays. Away from
   the ball, a dash is a normal beetle dash.
4. A ball moving at 3 tiles/s or more squashes spiders it touches (same
   floor). The ball also picks up batteries it rolls over.
5. Spiders hit the beetle, not the ball.

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

## Cotton stainers

(The vent enemies; `type: 'stainer'` in the code, formerly "spiders".)
Drawn as *Dysdercus*: flat red oval with pale seams, black triangle, black
wing spots and membrane tip, long black antennae, six black legs, a faint
red glow of their own so the warning colours read in the dark.

| Property | Default | Unit |
|---|---|---|
| Radius | 0.18 | tiles |
| Wander / flee speed | 1.1 / 3.2 | tiles/s |
| Fear radius (alone) | 2.2 | tiles |
| Aggro range | 4.5 | tiles |
| Pair range | 1.3 | tiles |
| Regroup range / speed | 6 / 1.8 | tiles, tiles/s |
| Wind-up | 0.45 | s |
| Lunge speed / time | 6.5 / 0.35 | tiles/s, s |
| Thrown speed / time | 5 / 0.5 | tiles/s, s |
| Attack cooldown | 3 | s |
| Hit: health / heat / knockback / stun / invulnerable | −1 / 0.45 / 7 / 0.35 / 0.8 | hp, heat, tiles/s, s, s |
| Dash kill reach (beyond touching) | 0.12 | tiles |

1. Spawn from vents (see Vents); `b` or `s` in a map places one at the start
   (used by tests). Movement is in the simulation with a seeded PRNG, so a
   run is reproducible from its seed.
2. **Alone they are cowards.** A spider with no partner wanders (new heading
   or a pause every 0.8–2.6 s) and runs from the player inside the fear radius.
   If the player is within aggro range and another free spider is within
   regroup range, it walks to that spider instead.
3. **They attack only in pairs.** Two free spiders (wandering, no cooldown)
   within pair range of each other, with the player within aggro range of
   one of them, form a pair. Both stop and wind up for 0.45 s; a crackling
   electric arc links them and their eyes glow. A lone spider never attacks.
4. Then both lunge in a straight line at where the player was (6.5 tiles/s for
   0.35 s). The first touch hits the player: heat +0.45 (can overheat),
   knockback, 0.35 s stun (no input, no dash), 0.8 s invulnerability.
5. When the lunge ends, the two are **thrown apart** to opposite sides and
   partly backwards (5 tiles/s, no control for 0.5 s), then cannot pair up for
   3 s. So a pair can't strike again straight away.
6. If one dies during the wind-up, the other still lunges alone.
7. **A dash kills a spider** it touches (within the radii plus 0.12). A dash
   beats a lunge: a dashing player is not hit. Walking into one does nothing.
   Dead spiders stay where they fell, legs curled.
8. Drawn with eight legs (two alternating groups of four, at most four feet
   in the air), a large abdomen and eyes that always glint faintly.

## Health and death

1. The bug has 10 health. Each spider hit costs 1 (plus the heat, knockback
   and stun listed under Spiders).
2. At 0 health the bug dies: the simulation freezes (no input, timer stops)
   and the run is lost. `R` restarts.

## Battery cells

(Called `shards` in the code.)

| Kind | Map char | Charges |
|---|---|---|
| Small cell | `*` | +3 |
| Big red battery | `B` | +9 |

1. Picked up when the player centre is within `radius + 0.35` of the cell.
2. When every cell (small and big) is collected the run is won and the timer stops.
3. `R` restarts the level with the current tunables.

## Vents

| Property | Default | Unit |
|---|---|---|
| First spawn | 1.5 – 3.5 | s |
| Spawn interval | 4 – 8 | s, per vent |
| Most spiders alive at once | 8 | |
| No spawn if the player is within | 1.5 | tiles |
| Emerging | 0.6 | s |
| Corpses stay for | 12 | s |

1. Vents (`V` in the map) are floor grates; you can walk over them.
2. Each vent has its own timer (seeded PRNG). When it runs out and fewer than
   8 spiders are alive, a spider crawls out; the timer restarts.
3. A new spider spends 0.6 s emerging (it can't move or attack, but a dash
   kills it), then gets a 1.5 s attack cooldown before it may pair up.
4. Dead spiders are removed after 12 s; the renderer leaves their husk on the
   floor.

## Cocoons and web turrets

| Property | Default | Unit |
|---|---|---|
| Cocoon radius | 0.32 | tiles |
| Turret range | 7 | tiles |
| Turret turn speed | 3 | rad/s |
| Wind-up before a shot | 0.45 | s |
| Reload | 2.6 × 0.8–1.2 | s |
| Web speed / radius / range | 6.5 / 0.18 / 9 | tiles/s, tiles, tiles |
| Web slowdown | speed and acceleration × 0.45 for 2.5 s | |

1. Cocoons (`O` in the map) are silk egg sacs with a riveted turret collar.
   They are solid: you can't walk through one.
2. The turret sees you within 7 tiles, within 1.5 levels, with a clear line
   (no wall, no ground higher than half a level above the line). It turns
   toward you; once lined up (within 0.2 rad) and reloaded it charges for
   0.45 s (the barrel glows), then fires. Its eye glows red while it sees you.
3. A web flies straight, trailing a silk thread back to its turret. It sticks
   to walls and higher ground (and stays there a few seconds) and drops after
   9 tiles.
4. A hit wraps you in a web: speed and acceleration × 0.45 for 2.5 s (the
   dung beetle pushes its ball at × 0.45 too). The net is drawn round the bug,
   strung from its body to its feet and the ground, trembling as it moves;
   when it wears off it fades out over 0.6 s.
5. Starting a dash tears the web (the net bursts apart and fades in 0.3 s).
   Webs do not stick to you during a dash.
6. A cocoon takes **3 hits**. Each dash counts once: the dash stops and you
   bounce off (4 tiles/s). A ball at squash speed counts once per bounce (it
   bounces off; 0.4 s between ball hits). Each hit shakes the turret (no shot
   for 0.6 s). Looks: 2 left = split silk weeping ichor; 1 left = torn open,
   eyes glowing inside, a leg twitching out; three lights on the collar show
   what's left. On the third hit it bursts, leaving a torn husk, and a spider
   drops out from 1.4 levels above it and lands.

## Spiders (from cocoons)

| Property | Default | Unit |
|---|---|---|
| Stalk speed | 2.6 | tiles/s |
| Notices you within | 8 | tiles |
| Lunge from / wind-up | 1.6 / 0.3 | tiles, s |
| Lunge speed / time | 7.5 / 0.28 | tiles/s, s |
| Cooldown after a lunge | 1.6 | s |

1. A black widow (glossy black, red hourglass). It hunts alone: no pairs.
2. Stalks straight toward you, winds up briefly when close and on your
   floor, lunges, recovers. Same hit as a stainer (1 health, heat, knockback).
3. Killed by a dash or a fast ball, like stainers. Vents don't count spiders
   toward their limit of 8.

## Events

The simulation appends events to `state.events` (`spawn`, `kill` with the dash
direction, `hit`, `pickup`, `corpse`, `death`, `win`, `land` with height,
`kick`, `shoot`, `webbed`, `webTorn`, `webFree`, `webSplat`, `cocoon`,
`spiderDrop`). The browser drains them
each frame for effects. Simulation logic never reads them.

## HUD: vitals panel

Bottom left, 168 × 52 art pixels, biomechanical (H. R. Giger-like): a
toothed halftone backplate, two segmented cords, bone vertebrae and seed pods.
Painted with gradients and glows, then snapped to the game palette with the
same ordered dither as the world (outline kept crisp). Shown at 2× (1.5× on
phones, which is 3 device pixels per art pixel on 2× screens).

1. Health: a spine of 10 vertebrae, each holding a capsule of blood. Lost
   health leaves a dark, cracked capsule. Flashes on a hit.
2. Charges: 10 housings of 3 cell slots each (30 slots).
3. A heart-like organ at the end beats at the bug's BPM and goes dark when
   charges run out.

## Player out of charges

With 0 charges the bug goes dark: dull shell, unlit eye, no back light (it
stops blinking) and no head lamp or glow.

## Shadows

Shadows belong to the floor. Each frame the shadows of the player, enemies,
ball, batteries and cocoons are collected first; ground-level ones are drawn
right after the ground floor, and each raised tile or slope draws the ones
falling on it (same height), clipped to its top. So a tile drawn in front can
never cut through a shadow, and a shadow never floats over a lower tile.

## Blood

A dash kill sprays a splatter generated on the spot: a pool where the
spider died and droplets and streaks thrown along the dash direction (never
onto walls). Splatters and husks stay on the floor for the rest of the run.

## Look

1. The world is drawn into an offscreen canvas at a fixed art resolution: one
   art pixel = `pixel` world pixels (default 2, so a tile is 32 art pixels
   wide). **Zoom never changes the art**; it only changes the whole-number
   factor the frame is scaled up by (no smoothing), so zoom moves in steps.
   The camera snaps to whole art pixels.
2. Every pixel is then snapped to the fixed palette in `src/pixel.js`
   (`COLORS`), with 4×4 ordered dithering (default strength 6). All palette
   colours stay reachable (tested).
3. Lighting: the frame is darkened (default 0.55) except around lights (wall
   lamps, some of which flicker; battery glow and arcs; the bug's back light,
   head lamp and body glow), plus a coloured additive glow.
4. Rain in screen space, drawn before lighting so it shows near lights.
5. Look settings are tunable: art pixel size, dither, darkness, rain, palette on/off.

## Arena

32 × 32 tiles, mostly open: a few pillars and broken wall stubs, 5 vents,
12 small cells and 3 big red batteries. Terrain: a north-east plateau (level 1,
ramp from the west, stairs from the south) with a grated deck on it (level 2,
stairs), a south-west plateau (level 1, ramp from the east, stairs from the
north) and a small middle island (level 1, ramp from the south).

Raised floors are riveted metal deck plates (level 2: grating) with a bright
lip; cliff faces are dark concrete with drains, rust and moss; ramps have
grip grooves and worn hazard paint at the foot; stairs show treads and risers.
Blood stays on the floor it was spilled on.

## Not decided yet

- Whether killing spiders matters for winning (it doesn't yet).
- Fall damage (falls only stun for now).
- Health pickups or regeneration (none yet).
- Art direction beyond placeholder shapes.
