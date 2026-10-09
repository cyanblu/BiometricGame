# Working on this repo

- Spec first: behaviour changes go into `docs/SPEC.md`, then `src/sim.js`,
  then the tests in `test/`. Keep `DEFAULT_PARAMS` equal to the spec table.
- `src/sim.js`, `src/dynamics.js` and `src/bug.js` stay pure: no DOM, no
  `Math.random`, no wall-clock time. Randomness goes through `rand(state)`.
- Run `npm test` and `npm run build` before committing; commit the rebuilt
  `dist/shardfield.html`.
- `tools/build.mjs` concatenates modules, so top-level names must be unique
  across `src/*.js`.
