# Biometric

Isometric top-down pixel-art game prototype. Pick one of six bugs (cowboy
beetle, stag beetle, jumping spider, daddy longlegs, praying mantis, or a dung
beetle with a ball that has momentum). You are a small biomechanical bug
in a rain-soaked industrial ruin: collect every battery as fast as you can.
Each dash burns a charge (start 10, max 30); small cells give 3, big red
batteries 9. The yard has several levels joined by ramps and stairs, and
you can drop off any ledge. Cotton stainers crawl out of vents and only
attack in pairs; cocoon turrets shoot slowing webs and break open into
spiders; dash
through them to kill them. You have 10 health. Hits and dashes heat your
core; overheat and you lose your dash and slow to a crawl.
Bodies and legs are animated procedurally (second-order f/ζ/r motion plus
IK legs), tunable live in the panel.

## Play

- Single file, no install: open `dist/biometric.html` in a browser.
- From source: `npm run serve`, then open http://localhost:8000
  (ES modules need a local server; `file://` won't load them).

Controls: WASD or arrows to move, Space/Shift to dash, R to restart,
C to change bug, T for the tunables panel. Add `#debug` to the URL to expose the live state
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
src/bug.js         leg rig (4, 6 or 8 legs): alternating gait, two-bone IK
src/characters.js  the six playable bugs: proportions, motion, mechanics
src/levels.js      ASCII level maps
src/pixel.js       palette + pixel filter (quantize, ordered dither)
src/render.js      isometric renderer: low-res frame, lighting, rain, blood
src/vitals.js      health/charge panel (biomechanical pixel sprite)
src/main.js        loop, input, HUD, tunables panel
test/*.test.js     headless tests (node:test), incl. terrain + reachability
tools/build.mjs    single-file bundle
```
