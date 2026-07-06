# Chapter 2 — Modeling of trees

Distilled from ABOP Ch. 2. Source:
https://algorithmicbotany.org/papers/abop/abop-ch2.lowquality.pdf
Covers how the classic deterministic tree models (Honda; Aono & Kunii) become
**parametric L-systems with 3D turtle interpretation**. This is the first place
the abstract machinery of Ch. 1 is used to make recognizable trees, and it
introduces the reusable idioms: width tapering, tropism, and keeping branch
planes horizontal.

## Background models (context, not L-systems)
- **Cellular-space** models (Ulam, Meinhardt, Greene's voxel automata) grow
  branches on a grid and emphasize *interactions* (including vein
  reconnection/anastomosis and reaction to environment).
- **Honda's model** — the workhorse. Assumptions: straight segments; each mother
  segment splits into two daughters; daughter lengths shrink by ratios `r1`,`r2`;
  mother + daughters share a **branch plane** kept as horizontal as possible;
  daughters make fixed angles `a1`,`a2`; laterals off the trunk keep a constant
  **divergence angle**.
- **Stochastic** tree models (Reeves & Blau; de Reffye's bud model with
  do-nothing / flower / internode / die outcomes) map onto the 23 tree
  architectures of Hallé–Oldeman–Tomlinson.

## The reusable L-system idioms

**Width tapering (`!` + da Vinci's rule).** `!(w)` sets line width to `w`. Da
Vinci's postulate — the daughters together equal the mother in cross-section —
gives, for `n` equal daughters, `w₁² = n·w₂²`, so the per-step factor is
`wr = 1/√n`: **0.707** for binary splits, **1/√3 ≈ 0.577** (or its inverse
`vr = √3 ≈ 1.732` when *widening* a growing model) for ternary.

**Divergence angle.** Laterals around an axis are spaced by a fixed roll `/(d)`;
`d = 137.5°` is the golden/phyllotactic angle (see Ch. 4).

**Keeping the branch plane horizontal (`$`).** The `$` operator re-rolls the
turtle so its left vector L is horizontal: `L = (V×H)/|V×H|`, `U = H×L`, where
`V` is "up" (opposite gravity). Use it after a lateral so branches don't spiral
out of plane.

**Tropism (branch bending).** After each segment, rotate the heading slightly
toward a tropism vector `T` by `α = e·|H×T|` (torque analogy; `e` = bending
susceptibility). Models wind, gravity (plagiotropism), and phototropism.

## The three canonical tree L-systems

**Monopodial** (Honda; clear main + lateral axes). Alternating B/C productions
issue laterals left/right:
```
#define r1 .9  r2 .6  a0 45  a2 45  d 137.5  wr .707
ω : A(1,10)
A(l,w) → !(w)F(l)[&(a0)B(l*r2,w*wr)]/(d)A(l*r1,w*wr)
B(l,w) → !(w)F(l)[-(a2)$C(l*r2,w*wr)]C(l*r1,w*wr)
C(l,w) → !(w)F(l)[+(a2)$B(l*r2,w*wr)]B(l*r1,w*wr)
```
Parameter sets a–d (Table 2.1): vary `r2 ∈ {.6,.9,.8,.7}` and angles.

**Sympodial** (Aono & Kunii; both daughters angled, no dominant axis):
```
#define r1 .9  r2 .7  a1 10  a2 60  wr .707
ω : A(1,10)
A(l,w) → !(w)F(l)[&(a1)B(l*r1,w*wr)]/(180)[&(a2)B(l*r2,w*wr)]
B(l,w) → !(w)F(l)[+(a1)$B(l*r1,w*wr)][-(a2)$B(l*r2,w*wr)]
```
Table 2.2 sweeps `a1`,`a2` from very asymmetric (5°/65°) to symmetric (35°/35°).

**Ternary** (three branches per step) — written in the *growing* style where old
segments keep elongating (`F(l)→F(l*lr)`) and widening (`!(w)→!(w*vr)`), with
tropism applied via `T`,`e`:
```
#define d1 94.74  d2 132.63  a 18.95  lr 1.109  vr 1.732
ω : !(1)F(200)/(45)A
A     → !(vr)F(50)[&(a)F(50)A]/(d1)[&(a)F(50)A]/(d2)[&(a)F(50)A]
F(l)  → F(l*lr)
!(w)  → !(w*vr)
```
Table 2.3 gives four looks (a–d), including a wind-blown one with a slanted
tropism vector `T=(-0.61,0.77,-0.19)`, `e=0.40`.

## Takeaways
- Trees = **parametric bracketed L-systems**: `[...]` for each branch, parameters
  carrying length + width, `!` for taper, `$`/`/` for orientation, `&` for pitch.
- Two equivalent construction styles: assign final length at birth, **or** create
  constant-length segments and elongate them each step (the latter reads as
  *growth* and foreshadows the developmental models of Ch. 3).
- These give generic tree shapes; species-specific, biologically-grounded models
  are the subject of Ch. 3 (herbaceous plants), where L-systems shine most.
