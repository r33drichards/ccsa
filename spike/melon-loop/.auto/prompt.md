# Autoresearch session: melon compressor

## Objective
Edit `prog.lua` until the sim metric reaches **5/5** (every postcondition passes).
The metric is the number of sim assertions passed, maximized by `.auto/measure.sh`.

## Scope
- Edit **only** `prog.lua`.
- The turtle is a stationary CRAFTY turtle: input chest ABOVE (`minecraft:melon_slice`),
  output chest BELOW (`minecraft:melon`).
- Behaviour: drain slices from above, compress 9 → 1 with `turtle.craft()`, drop
  blocks below, return leftover slices (< 9) upward. No movement / GPS / `sim.*`.

## How to run one experiment (what the tool does)
Each measurement ships `prog.lua` into the sandbox `/work` and runs the sim via
`run_js` against the self-hosted languages server, then counts passing assertions.
Read the stderr `FAIL -` lines to decide the next edit.

## Ideas log
- v0: drains only → ~1/5.
- next: arrange 9 slices per grid cell, craft, deposit, return leftovers.
