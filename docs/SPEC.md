# Shardfield behaviour spec (v0.1)

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

## Shards

1. Picked up when the player centre is within `radius + 0.35` of the shard.
2. When every shard is collected the run is won and the timer stops.
3. `R` restarts the level with the current tunables.

## Not decided yet

- What the game is about beyond moving and collecting.
- Enemies, hazards, health.
- Art direction beyond placeholder shapes.
