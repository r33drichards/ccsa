# Overview, Appendices & Glossary (ABOP front/back matter)

Distilled from ABOP front matter and appendices. Sources:
https://algorithmicbotany.org/papers/abop/abop-fm.lowquality.pdf and
https://algorithmicbotany.org/papers/abop/abop-bm.lowquality.pdf
Orientation for the whole book plus the **authoritative turtle-symbol table**
(Appendix C) and a glossary of terms. Read this first if you're not sure which
chapter reference you need.

## What the book is about
*The Algorithmic Beauty of Plants* (Prusinkiewicz & Lindenmayer, 1990; free
electronic edition 2004) argues that plant form and beauty come from two things
beyond the usual symmetry: **(1) simple developmental algorithms** (rules of
growth in time) and **(2) self-similarity** (each part resembles the whole,
because it was produced by the same recursive process). L-systems (Lindenmayer,
1968) are the formal tool; adding a **turtle-geometry** interpretation makes them
draw. "Organic form is a function of time" (d'Arcy Thompson) is the guiding idea.

## Chapter map (which reference to open)
- **ch1** — *the foundation*: L-system formalism (D0L, stochastic, context-
  sensitive, parametric), turtle interpretation (2D & 3D), bracketed branching,
  classic fractal curves, growth functions. Start here for any core question.
- **ch2** — tree models (Honda/Aono&Kunii): parametric branching, width taper,
  tropism, `$`.
- **ch3** — developmental models of herbaceous plants: 3 specification levels,
  control mechanisms (signal/delay/…), branching-pattern algebra, inflorescences.
- **ch4** — phyllotaxis: the 137.5° angle, Vogel's sunflower formula, cylinder
  packing.
- **ch5** — organ surfaces: `~` predefined surfaces, `{ . }` grown polygons,
  compound leaves.
- **ch6** — animation via **timed** DOL-systems + continuity of growth functions.
- **ch7** — cellular layers: **map/cellwork L-systems** (a different, graph-
  rewriting formalism) + dynamic (spring/pressure) geometry.
- **ch8** — fractal properties: self-similarity, IFS, Barnsley fern, L-system→IFS.

## Appendix C — Turtle interpretation of symbols (authoritative)
The canonical alphabet. Step size `d`, angle increment `δ` are set outside the
string (or per-symbol in parametric form). `scripts/lsystem.py` implements the 2D
subset (`F f + - | [ ] ! '` plus `G`); the rest are documented for completeness.

| symbol | interpretation |
|---|---|
| `F` | move forward and **draw** a line |
| `f` | move forward **without** drawing |
| `+` | turn **left** (yaw, about U) |
| `-` | turn **right** (yaw, about U) |
| `^` | pitch **up** (about L) |
| `&` | pitch **down** (about L) |
| `\` | roll **left** (about H) |
| `/` | roll **right** (about H) |
| `\|` | turn around (180°) |
| `$` | rotate the turtle to **vertical** (bring L horizontal; used for tree branch planes) |
| `[` | start a branch (push state) |
| `]` | complete a branch (pop state) |
| `{` | start a polygon |
| `G` | move forward and draw, but **do not record a polygon vertex** |
| `.` | record a vertex in the current polygon |
| `}` | complete (fill) the polygon |
| `~` | incorporate a predefined surface |
| `!` | decrement the diameter of segments (line width) |
| `'` | increment the current color-table index |
| `%` | cut off the remainder of the branch (prune) |

Reserved statements used in specifications: `#define name value` (constants),
`#include shape` (predefined surface/shape library), `#ignore symbols` (symbols
skipped during context matching).

## Appendix A — Software environment (historical reference)
Models were built in a "virtual laboratory": a microworld (interactive
experiments) plus hypertext, with object inheritance/version control. The core
programs — useful as a checklist of what an L-system toolchain needs:
- **Pfg** (Plant and fractal generator): derives an L-system (parametric or not)
  and turtle-interprets it; outputs to screen, PostScript, or a ray-tracer.
- **Spiral**: interactive phyllotaxis (planar/cylindrical), faster than growing
  organs with L-systems (Ch. 4).
- **Ise**: interactive bicubic-surface (patch) editor for organs (Ch. 5).
- **Mapl**: map-L-system interpreter with the dynamic method; does spheres and 3D
  cellworks (Ch. 7).
- **Panel**: control-panel manager (sliders/buttons → live parameters).
- **Rayshade** (Kolb) / **Preray**: ray tracer + wireframe previewer.
- **L.E.G.O.**: model man-made objects via Euclidean constructions.
- **Ifsg** (Hepting): IFS renderer (attracting / distance / escape-time) (Ch. 8).

## Glossary (from the index)
- **axiom** — the starting word `ω`. **production** — a rewrite rule. **successor
  / predecessor** — right/left side of a rule. **identity production** — `a→a` for
  unmentioned letters.
- **derivation** — one parallel rewrite step; **derivation length** — number of
  steps. **developmental sequence** — the words `ω=μ₀⇒…⇒μₙ`.
- **plastochron** — time between successive internodes. **apex** (vegetative
  `a`/flowering `A`), **internode** `I`, **developmental switch** — apex changing
  state.
- **module** — a letter with parameters `A(…)`. **condition** — the logical guard
  in a parametric production.
- **heading / left / up (H,L,U)** — the 3D turtle orientation frame.
- **branching**: monopodial / sympodial / polypodial / terminal (see ch3).
- **signal** — a context-propagated symbol; **acropetal** (base→apex) via left
  context, **basipetal** (apex→base) via right context.
- **phyllotaxis / parastichy / divergence angle / golden mean** (ch4).
- **map / region / edge / marker / cellwork** (ch7). **IFS / attractor / chaos
  game / controlled IFS** (ch8). **timed letter / age / lifetime** (ch6).
- **data base amplification** — complex output from a tiny specification.
- **phase effect** — coexistence of organs at different developmental stages.
- **da Vinci's postulate** — daughter branch cross-sections sum to the mother's.
- **self-similarity** — parts geometrically similar to the whole.
