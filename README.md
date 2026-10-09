# Biometric

Isometric top-down pixel-art game prototype. You are a small mechanical bug
in a rain-soaked industrial ruin: collect every battery cell as fast as you
can. Each dash burns a charge, each cell gives one back. Spiders only attack
in pairs; dash through them to kill them. Hits and dashes heat your core;
overheat and you lose your dash and slow to a crawl.
Bodies and legs are animated procedurally (second-order f/ζ/r motion plus
IK legs), tunable live in the panel.

## Play

- Single file, no install: open `dist/biometric.html` in a browser.
- From source: `npm run serve`, then open http://localhost:8000
  (ES modules need a local server; `file://` won't load them).

Controls: WASD or arrows to move, Space/Shift to dash, R to restart,
T for the tunables panel. Add `#debug` to the URL to expose the live state
as `window.biometricDebug` for scripted tests. Gamepad (left stick, A) and touch (drag on the
left, Dash button) also work.

## How this project is built

1. `docs/SPEC.md` describes the behaviour in plain words and numbers.
2. `src/sim.js` implements it with no DOM, so it runs headless.
3. `test/sim.test.js` checks the sim against the spec: `npm test`.
4. `src/render.js` and `src/main.js` draw it and read input.
5. The Tunables panel changes the numbers live. "Copy values" gives JSON
   to paste back into the spec once a feel is right.

`npm run build` bundles everything into `dist/biometric.html`.

## Layout

```
docs/SPEC.md       behaviour spec (source of truth for numbers)
src/sim.js         simulation: movement, dash charges, collision, heat, spiders
src/dynamics.js    second-order f/zeta/r follower (procedural motion)
src/bug.js         leg rig (6 or 8 legs): alternating gait, two-bone IK
src/levels.js      ASCII level maps
src/pixel.js       palette + pixel filter (quantize, ordered dither)
src/render.js      isometric renderer: low-res frame, lighting, rain
src/main.js        loop, input, HUD, tunables panel
test/*.test.js     headless tests (node:test)
tools/build.mjs    single-file bundle
```
