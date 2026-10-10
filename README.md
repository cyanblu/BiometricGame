# Biometric

Isometric top-down pixel-art game prototype. Pick one of six bugs (cowboy
beetle, stag beetle, jumping spider, daddy longlegs, praying mantis, or a dung
beetle with a ball that has momentum). You are a small biomechanical bug
in a rain-soaked industrial ruin, the Sprawl: an 80 x 80 generated arena of
five biomes (Pump Yard, Overgrown Garden, Rust Foundry, Flooded Drains, The
Hive) with raised floors, ramps and stairs. Collect every battery. Each dash
burns a charge (start 10, max 30); small cells give 3, big red batteries 9.

Inspired by how Rain World treats its creatures (an ecosystem the player is
just part of) but with its own bugs, art and code:
- A rain cycle: when the timer runs out a deadly downpour falls. Eat gnats
  for food and curl up in a shelter hatch before it comes; a fed sleep heals.
- A food chain: gnats flee and get eaten, by you and by hungry stainers.
- Hearing: landings, dashes and kills make noise; idle creatures come to
  look where it came from, not at you.
- Creatures go home to their vents before the rain. Vents remember their
  dead and send back tougher elders.
- Layered threat music and rain, synthesized live (N mutes).

Cotton stainers only attack in pairs; cocoon turrets shoot slowing webs and
break open into spiders; dash through them to kill them. You have 10
health. Hits and dashes heat your core; overheat and you lose your dash.
Bodies and legs are animated procedurally (second-order f/ζ/r motion plus
IK legs), tunable live in the panel.

## Play

- Single file, no install: open `dist/biometric.html` in a browser.
- From source: `npm run serve`, then open http://localhost:8000
  (ES modules need a local server; `file://` won't load them).

Controls: WASD or arrows to move, Space/Shift to dash, R to restart,
C to change bug, M for the map, N for sound, T for the tunables panel. Add `#debug` to the URL to expose the live state
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
src/sim.js         simulation: movement, terrain, creatures, rain cycle, gnats, hearing
src/dynamics.js    second-order f/zeta/r follower (procedural motion)
src/bug.js         leg rig (4, 6 or 8 legs): alternating gait, two-bone IK
src/characters.js  the six playable bugs: proportions, motion, mechanics
src/levels.js      seeded arena generator (biomes, plateaus, items), validated
src/pixel.js       palette + pixel filter (quantize, ordered dither)
src/render.js      isometric renderer: low-res frame, fog, lighting, rain, minimap
src/audio.js       Web Audio: layered threat music, rain
src/vitals.js      health/charge panel (biomechanical pixel sprite)
src/main.js        loop, input, HUD, tunables panel
test/*.test.js     headless tests (node:test), incl. terrain + reachability
tools/build.mjs    single-file bundle
```
