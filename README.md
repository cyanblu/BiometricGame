# BiometricGame

Isometric top-down game prototype, working title **Shardfield**. Move, dash,
collect every shard in the level as fast as you can.

## Play

- Single file, no install: open `dist/shardfield.html` in a browser.
- From source: `npm run serve`, then open http://localhost:8000
  (ES modules need a local server; `file://` won't load them).

Controls: WASD or arrows to move, Space/Shift to dash, R to restart,
T for the tunables panel. Gamepad (left stick, A) and touch (drag on the
left, Dash button) also work.

## How this project is built

1. `docs/SPEC.md` describes the behaviour in plain words and numbers.
2. `src/sim.js` implements it with no DOM, so it runs headless.
3. `test/sim.test.js` checks the sim against the spec: `npm test`.
4. `src/render.js` and `src/main.js` draw it and read input.
5. The Tunables panel changes the numbers live. "Copy values" gives JSON
   to paste back into the spec once a feel is right.

`npm run build` bundles everything into `dist/shardfield.html`.

## Layout

```
docs/SPEC.md       behaviour spec (source of truth for numbers)
src/sim.js         simulation: movement, dash, collision, pickups
src/levels.js      ASCII level maps
src/render.js      isometric canvas renderer
src/main.js        loop, input, HUD, tunables panel
test/sim.test.js   headless tests (node:test)
tools/build.mjs    single-file bundle
```
