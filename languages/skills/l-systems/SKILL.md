---
name: l-systems
description: Create, expand, and render Lindenmayer systems (L-systems) — the parallel string-rewriting grammars behind procedural plants and fractals, distilled from Prusinkiewicz & Lindenmayer's 'The Algorithmic Beauty of Plants' (ABOP). Use whenever a task involves L-systems or turtle-graphics generation — writing or debugging productions and grammars; fractal curves (Koch, Sierpiński, dragon, Hilbert, Peano, Gosper, space-filling); procedural plants, trees, leaves, or branching structures; phyllotaxis and spiral organ layouts (137.5° golden angle); or any variant — D0L, bracketed, stochastic, context-sensitive, parametric, timed, or map/cellwork. Trigger even when the user only says 'Lindenmayer', 'turtle fractal', or 'procedural tree', names one of those curves, or pastes rules like F → F+F−F. Ships runnable Python and JavaScript engines that expand and render to SVG, plus per-chapter ABOP references covering the formalism, the full turtle alphabet, exact productions, and canonical plant and fractal models.
---

# L-systems (The Algorithmic Beauty of Plants)

An **L-system** is a grammar whose productions are applied to **every symbol at
once** each step (parallel rewriting — this is what separates it from a Chomsky
grammar). Expand an axiom for `n` steps, then feed the resulting string to a
**turtle** that reads each symbol as a drawing command. Tiny rule sets produce
astonishingly complex plants and fractals ("data base amplification").

This skill is distilled from Prusinkiewicz & Lindenmayer, *The Algorithmic Beauty
of Plants* (free: https://algorithmicbotany.org/papers/#abop). The `references/`
directory holds one file per chapter; **load only what the task needs** (see the
map below). For most requests the quick reference here plus the bundled engine is
enough — reach for a chapter file when you need depth or a specific model.

## Quick start — run the engine

Two equivalent engines live in `scripts/`. Both expand a system and emit SVG.

```bash
# Python: render a built-in example, or pipe a JSON spec
python scripts/lsystem.py --demo plant_a -o plant.svg
echo '{"axiom":"F","rules":{"F":"F[+F]F[-F]F"},"n":5,"angle":25.7,"start_heading":90,"step":6}' \
  | python scripts/lsystem.py -o plant.svg
```
```js
// JavaScript (tbjs sandbox or an HTML artifact): render(spec) / demo(name) → SVG
const { render } = require("./scripts/lsystem.js");
const svg = render({ axiom: "F", rules: { F: "F[+F]F[-F]F" }, n: 5, angle: 25.7, startHeading: 90, step: 6 });
```
Built-in demos: `koch_island snowflake sierpinski dragon hilbert gosper plant_a
plant_b plant_c plant_d plant_e plant_f stochastic_bush`. Prefer the SVG output as
an inline artifact; for quick arithmetic (expansion lengths, growth rates) run it
in tbjs rather than estimating.

## Writing a system

A spec has an **axiom**, **rules**, an iteration count **n**, a turn **angle** (°),
a **step** length, and a **start_heading** (° — 90 = up, good for plants; 0 = east,
good for curves). Rule values:
```
"F": "F+F-F"                                  deterministic (D0L)
"F": [["F[+F]F", 1/3], ["F[+F]", 1/3], ["F[-F]", 1/3]]   stochastic (weights)
```
Any letter with no rule keeps itself (identity). Letters like `A X L R 0 1` drive
rewriting but aren't drawn — only the turtle symbols below move the pen.

## Core turtle alphabet (2D — the common case)

The authoritative full table (2D + 3D + polygons + surfaces) is in
`references/ch0-overview-and-appendices.md` (ABOP Appendix C). Everyday subset:

| symbol | action | symbol | action |
|---|---|---|---|
| `F` | forward, draw | `[` | push state (start branch) |
| `f` | forward, no draw | `]` | pop state (end branch) |
| `+` | turn left by angle (CCW) | `!` | thinner line |
| `-` | turn right by angle | `'` | next colour |
| `\|` | turn around 180° | `G` | forward, draw, no polygon vertex |

3D adds `& ^` (pitch), `\ /` (roll), `$` (level the branch plane); polygons use
`{ . }`; `~` attaches a predefined surface; `%` prunes. See ch0 / ch1.

## A few canonical systems (all are demos)

```
Koch island   δ=90°  heading 0   ω: F-F-F-F   F → F-F+F+FF-F-F+F
Dragon curve  δ=90°  heading 0   ω: FX  X → X+YF+   Y → -FX-Y
Hilbert (2D)  δ=90°  heading 0   ω: L   L → +RF-LFL-FR+   R → -LF+RFR+FL-
Plant (a)     δ=25.7° heading 90 ω: F   F → F[+F]F[-F]F
Bush (stoch.) δ=25.7° heading 90 ω: F   F →⅓ F[+F]F[-F]F | F[+F]F | F[-F]F
```
The six ABOP Fig. 1.24 plants (a–f) and their exact productions are in
`references/ch1-graphical-modeling.md`.

## Progressive disclosure — which reference to open

Read `references/ch0-overview-and-appendices.md` first if unsure; it has the full
symbol table, a glossary, and this same map. Otherwise jump straight to:

| I want to… | open |
|---|---|
| understand the formalism; get the full turtle alphabet; write fractal curves (Koch/dragon/Hilbert/Peano/Gosper), bracketed plants, stochastic/context-sensitive/parametric systems; reason about growth functions | **ch1-graphical-modeling.md** *(the core — start here for almost anything)* |
| model a **tree** (parametric branching, width taper via da Vinci's rule, tropism/wind, monopodial vs sympodial vs ternary) | **ch2-trees.md** |
| model a **developing plant / inflorescence** (apices, plastochrons, developmental switches, signals, raceme/cyme/panicle/umbel, acropetal vs basipetal) | **ch3-herbaceous-plants.md** |
| lay out **spirals of organs / phyllotaxis** (137.5° golden angle, sunflower head, pine cone, Fibonacci parastichies) | **ch4-phyllotaxis.md** |
| give organs **surfaces** (predefined `~` surfaces, grown `{ . }` polygons, leaf/compound-leaf models) | **ch5-plant-organs.md** |
| **animate** development smoothly (timed DOL-systems, continuous growth functions) | **ch6-animation.md** |
| model **cellular layers** — sheets of cells with cycles (map & cellwork L-systems, dynamic spring/pressure geometry) | **ch7-cellular-layers.md** |
| relate plants to **fractals / IFS** (self-similarity, Barnsley fern, converting an L-system to an IFS) | **ch8-fractal-properties.md** |
| book overview, **full symbol table**, glossary, historical toolchain | **ch0-overview-and-appendices.md** |

## Choosing a variant

- Just a shape or fractal → **D0L** (deterministic, context-free). ch1.
- Natural-looking variation across specimens → **stochastic** (weighted rules). ch1 §7.
- Signals / interaction between parts (hormones, apical dominance) → **context-
  sensitive** (`l<a>r`, `#ignore`). ch1 §8, ch3.
- Real lengths/angles, conditions, continuous growth → **parametric** (`A(x): cond
  → …`). ch1 §10. The bundled engine covers the first three; for parametric,
  pre-expand the arithmetic or use a dedicated interpreter (formalism in ch1).
- Smooth animation over time → **timed** DOL. ch6.
- Cell sheets with cycles (not trees) → **map / cellwork** L-systems. ch7.

## Common mistakes

- **Wrong turn sign / heading.** ABOP uses `+` = left (counter-clockwise), `-` =
  right; plants start pointing **up** (heading 90), curves usually **east** (0). If
  a plant grows sideways or a curve is mirrored, fix these first.
- **Unbalanced brackets.** Every `[` needs a matching `]`; the engine pops only on
  `]`. Mismatched brackets leave the turtle in the wrong state.
- **Treating control letters as drawn.** `X`, `A`, `L`, `R`, `0/1` are *not* drawn
  unless you add them to the draw set — `F`/`G` do the drawing. (Exception: some
  edge-rewriting curves like Gosper use `A`/`B` *as* forward moves — set the draw
  symbols accordingly; the `gosper` demo shows this.)
- **Too many iterations.** Growth is often exponential (`F→FF` doubles each step;
  `F[+F]F[-F]F` is 5ⁿ). Segment counts explode fast — start with small `n`.
- **137.5° not precise enough.** Phyllotaxis is exquisitely sensitive to the
  divergence angle; use several digits (`137.50776°`). ch4.
- **Reaching for map L-systems for a tree.** Trees/filaments are string/bracketed
  L-systems; only true cell *sheets with cycles* need map L-systems (ch7).

## Attribution

All formalism, productions, and models derive from P. Prusinkiewicz & A.
Lindenmayer, *The Algorithmic Beauty of Plants* (Springer, 1990; free electronic
edition 2004), https://algorithmicbotany.org/papers/#abop. The `references/` files
are original distillations (paraphrased text; productions and parameters are the
book's functional notation). Errata: https://algorithmicbotany.org/papers/abop/abop_errata.html
