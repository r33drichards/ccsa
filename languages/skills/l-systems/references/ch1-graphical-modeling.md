# Chapter 1 — Graphical modeling using L-systems

Distilled from Prusinkiewicz & Lindenmayer, *The Algorithmic Beauty of Plants*
(ABOP), Ch. 1. Source: https://algorithmicbotany.org/papers/abop/abop-ch1.lowquality.pdf
This is the foundational chapter: it defines the L-system formalism, every
major variant, and the turtle interpretation that turns a rewritten string into
a picture. Everything else in the book (and in `scripts/lsystem.py`) builds on it.

## Contents
1. The core idea: parallel rewriting
2. D0L-systems (deterministic, context-free) — formal definition
3. Turtle interpretation in 2D
4. Classic curves: Koch constructions, edge vs node rewriting, FASS curves
5. Turtle interpretation in 3D
6. Branching structures: axial trees, bracketed L-systems, the plant gallery
7. Stochastic L-systems
8. Context-sensitive L-systems (IL-systems)
9. Growth functions
10. Parametric L-systems
11. Consolidated turtle alphabet (2D + 3D)

---

## 1. The core idea: parallel rewriting

Rewriting builds a complex object by repeatedly replacing parts of a simple
one using **productions** (rewrite rules). The archetype is von Koch's
snowflake (1905): start from an *initiator* and replace every straight segment
with a scaled copy of a *generator* polygon, forever.

L-systems (Lindenmayer, 1968) are string-rewriting systems. The one property
that separates them from Chomsky grammars: **productions are applied in
parallel**, replacing every symbol of the current word simultaneously in each
step. This models simultaneous cell division in an organism, and it makes
L-systems strictly more powerful for some languages than context-free Chomsky
grammars. Two symbol-class names recur: **OL** = context-free ("zero-sided"),
**IL** = context-sensitive ("interactions").

## 2. D0L-systems (deterministic, context-free)

The simplest class. A **D0L-system** is a triplet `G = (V, ω, P)`:
- `V` — the alphabet (a finite set of letters),
- `ω ∈ V⁺` — the **axiom** (a nonempty starting word),
- `P ⊂ V × V*` — a finite set of **productions**, each written `a → χ`
  (predecessor `a`, successor `χ`).

Rules: every letter needs at least one production; a letter with no explicit
rule carries the **identity production** `a → a`. "Deterministic" = exactly one
production per letter.

**Derivation** `μ ⇒ ν`: replace every letter of `μ` by its successor at once.
A word is generated in `n` steps via `ω = μ₀ ⇒ μ₁ ⇒ … ⇒ μₙ`.

Toy example — `ω: b`, `a → ab`, `b → a` generates
`b, a, ab, aba, abaab, abaababa, …` (successive words are Fibonacci-length; see §9).

Biological example (Anabaena catenula filament), letters carry cell state +
polarity subscripts l/r:
```
ω : a_r
a_r → a_l b_r      a_l → b_l a_r      b_r → a_r      b_l → a_l
```

## 3. Turtle interpretation in 2D

Interpret the string as commands to a LOGO-style turtle. State = `(x, y, α)`:
position plus **heading** `α` (the direction it faces). Two fixed parameters:
step length `d` and angle increment `δ`.

| symbol | action |
|---|---|
| `F` | move forward `d`, **drawing** a line to `(x+d·cos α, y+d·sin α)` |
| `f` | move forward `d` **without** drawing |
| `+` | turn **left** by `δ` (α ← α+δ). Positive angles are counter-clockwise. |
| `-` | turn **right** by `δ` (α ← α−δ) |

Given a string, an initial state `(x₀,y₀,α₀)`, and `d, δ`, the picture is just
the set of segments the turtle draws. Any letter with no turtle meaning (e.g.
`A`, `X`) is skipped by the turtle but still drives rewriting — this is how
"control" symbols work.

**Koch constructions ↔ L-systems.** The initiator is the axiom, the generator
is a production successor, and predecessor `F` is one edge. Example — quadratic
Koch island (`δ = 90°`):
```
ω : F-F-F-F
F → F-F+F+FF-F-F+F
```
(`scripts/lsystem.py --demo koch_island`). A disconnected curve needs a second
production on `f` to keep components spaced correctly.

## 4. Classic curves: edge vs node rewriting

Two complementary construction styles, both tied to tilings of the plane.

**Edge rewriting** — productions replace polygon *edges*. Use two edge letters
`Fl`/`Fr` ("left"/"right"), both drawn as forward moves, so left/right turns can
differ. Examples straight from ABOP:
```
Dragon curve      δ=90°   ω: Fl    Fl → Fl+Fr+     Fr → -Fl-Fr
Sierpiński gasket δ=60°   ω: Fr    Fl → Fr+Fl+Fr   Fr → Fl-Fr-Fl
```
**FASS curves** (space-Filling, self-Avoiding, Simple, Self-similar) are finite
approximations of space-filling curves, e.g. the hexagonal **Gosper/flowsnake**
(δ=60°) and quadratic Gosper / E-curve.

**Node rewriting** — productions replace *nodes*, substituting subfigures with
entry/exit points and vectors. This yields the **Hilbert curve** as an
L-system (`L`, `R` are erased or ignored at interpretation time):
```
Hilbert (2D)  δ=90°   ω: L    L → +RF-LFL-FR+    R → -LF+RFR+FL-
```
and the **Peano curve** and other FASS curves via recursive tile subdivision.
> Note: `lsystem.py`'s built-in `hilbert`/`dragon` demos use common equivalent
> encodings (e.g. `A/B` with `-BF+AFA+FB-`); the ABOP forms above are equally
> valid. Edge- and node-rewriting classes overlap — the dragon can be written
> either way (via "pseudo-L-systems" that allow multi-letter predecessors).

## 5. Turtle interpretation in 3D

Represent orientation with three orthonormal vectors — **H** (heading), **L**
(left), **U** (up), with `H × L = U`. A rotation multiplies `[H L U]` by a 3×3
matrix `R`. Rotations about U, L, H by angle α use `R_U(α)`, `R_L(α)`, `R_H(α)`
(standard rotation matrices). Controlling symbols:

| symbol | action | symbol | action |
|---|---|---|---|
| `+` | turn left, `R_U(δ)` | `-` | turn right, `R_U(-δ)` |
| `&` | pitch down, `R_L(δ)` | `^` | pitch up, `R_L(-δ)` |
| `\` | roll left, `R_H(δ)` | `/` | roll right, `R_H(-δ)` |
| `|` | turn around, `R_U(180°)` | | |

A 3D Hilbert curve is built by the same node-replacement idea using cubes and
"macrocubes" instead of tiles.

## 6. Branching structures

Real plants branch, so a single turtle path is not enough.

**Axial trees** — rooted trees where, at each node, at most one outgoing
segment is the "straight" continuation; the rest are lateral. A maximal chain
of straight segments is an **axis**; an axis plus its descendants is a
**branch**. The root axis has order 0; a lateral off an order-`n` axis has
order `n+1`.

**Bracketed OL-systems** — encode axial trees as strings with two extra turtle
symbols:

| symbol | action |
|---|---|
| `[` | **push** turtle state (position, orientation, and attributes like color/width) onto a stack — start a branch |
| `]` | **pop** the stack, restoring that state — end a branch (no line drawn) |

Derivation proceeds as usual; brackets replace themselves. The six canonical 2D
plants (ABOP Fig. 1.24) — (a)–(c) edge-rewriting, (d)–(f) node-rewriting — are
the most-reproduced L-systems in existence:

```
(a) n=5  δ=25.7°  ω: F   F → F[+F]F[-F]F
(b) n=5  δ=20°    ω: F   F → F[+F]F[-F][F]
(c) n=4  δ=22.5°  ω: F   F → FF-[-F+F+F]+[+F-F-F]
(d) n=7  δ=20°    ω: X   X → F[+X]F[-X]+X      F → FF
(e) n=7  δ=25.7°  ω: X   X → F[+X][-X]FX       F → FF
(f) n=5  δ=22.5°  ω: X   X → F-[[X]+X]+F[+FX]-X F → FF
```
All six are `scripts/lsystem.py --demo plant_a … plant_f`.

**3D bush / flower** add filled polygons and attribute changes:
- `{` … `}` delimit a **filled polygon**; the vertices are the turtle positions
  of the enclosed forward moves (see Ch. 5).
- `!` decrements segment diameter (line width); `'` increments the color-table
  index.

Example (3D bush, `δ=22.5°`):
```
ω : A
A → [&FL!A]/////'[&FL!A]///////'[&FL!A]
F → S/////F      S → FL
L → ['''^^{-f+f+f-|-f+f+f}]
```

## 7. Stochastic L-systems

Deterministic L-systems make identical copies; real fields need variation. A
**stochastic OL-system** is `Gπ = (V, ω, P, π)` where `π: P → (0,1]` assigns
each production a probability, and for every letter the probabilities of its
productions **sum to 1**. At each occurrence of a letter, a production is chosen
per `π`, independently — so topology *and* geometry vary between specimens.

```
ω : F
F --0.33--> F[+F]F[-F]F
F --0.33--> F[+F]F
F --0.34--> F[-F]F
```
(`scripts/lsystem.py --demo stochastic_bush`; the engine takes `[(succ, weight), …]`.)

## 8. Context-sensitive L-systems (IL-systems)

Production choice can depend on neighbors — useful for signals (nutrients,
hormones). A **2L-system** production is `aₗ < a > aᵣ → χ`: strict predecessor
`a` rewrites only when preceded by `aₗ` and followed by `aᵣ`. **1L-systems**
have one-sided context (`aₗ < a → χ` or `a > aᵣ → χ`). Both are special cases of
**(k,l)-systems** (left context length k, right l). Conventions: context-
sensitive productions take precedence over context-free ones with the same
strict predecessor; unmatched letters map to themselves.

**Signal propagation** (a `b` walking right through a's):
```
ω : baaaaaaaa      b < a → b      b → a
→ abaaaaaaa → aabaaaaaa → …
```

**`#ignore`** lists symbols to treat as non-existent during context matching —
essential in bracketed strings, where matching must skip over branch symbols
`[ ]` and geometry symbols `+ -`. Acropetal (root→apex) signals use left
context; basipetal (apex→root) use right context:
```
#ignore : +-
ω : Fb[+Fa]Fa[-Fa]Fa[+Fa]Fa      Fb < Fa → Fb        (acropetal)
```
Hogeweg & Hesper's exhaustive study of bracketed 2L-systems over `{0,1}`
produced many plant shapes; e.g. (δ=22.5°, `#ignore: +-F`, axiom `F1F1F1`) with
a full table of `l<p>r → s` rules including `* < + > * → -`.

> Engine note: `lsystem.py` matches context **linearly** with an ignore set —
> correct for non-branching signals and simple cases. Full ABOP semantics
> (matching that descends into/across brackets) is not implemented; see the
> bracketed-context discussion above if you need it.

## 9. Growth functions

A **growth function** gives word length as a function of derivation length `n`.
For D0L-systems it is independent of letter order, so it can be read off a
matrix `Q` where `q_ij` = number of `aⱼ` in the successor of `aᵢ`; then
`(count vector at k) · Q = (count vector at k+1)`.

- **Exponential:** `F → FF` doubles each step → `length = 2ⁿ` (used to elongate
  internodes in plants d/e/f).
- **Fibonacci:** `a → ab, b → a` → counts follow 1,1,2,3,5,8,…
- **Polynomial (Pascal's triangle):** the chain `aᵢ → aᵢaᵢ₊₁` makes the count of
  `aᵢ` a degree-`i` polynomial in `n` — identify `aᵢ` with `F` for polynomial
  elongation of any degree.
- In general `f_G(n) = Σ Pᵢ(n)·ρᵢⁿ` (polynomial × exponential terms).
- **Sigmoidal** and **square-root** growth fall outside that class; approximate
  the first by enlarging the alphabet, the second with a context-sensitive
  system (a signal bounces off an end marker `X`, extending the string on a
  quadratic schedule).

The practical lesson (Vitányi): you often *cannot* get a desired growth curve
from ordinary L-systems — which motivates parameters.

## 10. Parametric L-systems

Attach real-valued parameters to letters. A **module** is `A(a₁,…,aₙ)`. A
**parametric OL-system** is `G = (V, Σ, ω, P)` where `Σ` is a set of formal
parameters and productions have three parts separated by `:` and `→` —
**predecessor**, **condition** (a logical expression), **successor** (modules
whose parameters are arithmetic expressions):
```
A(t) : t > 5 → B(t+1) C D(t^0.5, t-2)
```
A production matches a module when the letters agree, the parameter counts
agree, and the condition is true; parameters substitute by position. Operators:
`+ - * / ^`, relational `< > =`, logical `! & |`, parentheses; relational/
logical results are 0/1, an empty condition is true. Context-sensitive
parametric productions test parametric words on each side, e.g.
`A(x) < B(y) > C(z) : x+y+z > 10 → E((x+y)/2) F((y+z)/2)`.

**Parametric turtle** — the first parameter drives the turtle; a bare symbol
falls back to the default `d`/`δ`:
| module | action |
|---|---|
| `F(a)` | forward `a`, drawing |
| `f(a)` | forward `a`, no draw |
| `+(a)` | rotate about U by `a`° (left if `a>0`) |
| `&(a)` | rotate about L by `a`° (pitch down if `a>0`) |
| `/(a)` | rotate about H by `a`° (roll right if `a>0`) |

`#define` sets constants, `#include` pulls in predefined shapes, `#ignore`
as before. A compact, important example is the self-similar branching model
that becomes a real developmental model in Ch. 2–3:
```
#define R 1.456
ω : A(1)
A(s) → F(s)[+A(s/R)][-A(s/R)]           (δ=85°, appends shrinking segments)

-- equivalent "growing" form (segments lengthen each step):
ω : A     A → F(1)[+A][-A]      F(s) → F(s*R)
```
The Anabaena-with-heterocysts model (`L-system 1.1`) is the flagship parametric
2L-system: cells `F(s,t,c)` divide (p1/p2), diffuse/decay a compound
`c ← c + 0.25(k+r−3c)` across neighbors (p3), and differentiate into
heterocysts when young and low-concentration (p4).

> `scripts/lsystem.py` covers the **non-parametric** classes (D0L, stochastic,
> context-sensitive, bracketed) end-to-end. For parametric systems, either
> pre-expand the arithmetic yourself or use a dedicated parametric interpreter;
> the formalism above is what such an interpreter must implement.

## 11. Consolidated turtle alphabet

2D + 3D, as used across ABOP and by the engine. Sizes: step `d`, angle `δ`.

| symbol | meaning |
|---|---|
| `F` / `F(a)` | forward, draw (length `d` / `a`) |
| `f` / `f(a)` | forward, no draw |
| `G` | forward, draw (alt. edge letter; also used inside polygons) |
| `+` `-` | yaw left / right by `δ` (about U) |
| `&` `^` | pitch down / up by `δ` (about L) |
| `\` `/` | roll left / right by `δ` (about H) |
| `\|` | turn around 180° |
| `[` `]` | push / pop turtle state (branch start / end) |
| `{` `}` | begin / end a filled polygon |
| `!` | decrement line width |
| `'` | increment color-table index |
| others (`A`,`B`,`X`,`Y`,`L`,`R`,`0`,`1`,…) | not drawn; drive rewriting only |
