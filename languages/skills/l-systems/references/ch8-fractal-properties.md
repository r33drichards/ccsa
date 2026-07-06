# Chapter 8 — Fractal properties of plants

Distilled from ABOP Ch. 8. Source:
https://algorithmicbotany.org/papers/abop/abop-ch8.lowquality.pdf
Ties the whole book to **fractals**. The connecting idea is **self-similarity**:
plant structures are (approximately) built from reduced copies of themselves, so
they can be rendered with fractal algorithms — and there's a precise recipe for
turning a developmental L-system into an **iterated function system (IFS)**.

## Are plants fractals?
Strictly (Mandelbrot): a fractal has Hausdorff dimension `D_H` strictly above its
topological dimension `D_T`. By that definition *nothing* in the book qualifies —
every figure is finitely many line segments (`D_H = D_T`). But a finite curve is a
useful **approximation** of an infinite fractal when it shares the key property —
here, self-similarity. The productive stance: treat fractals as **abstract
descriptions of real structures**, not the reverse. Justification (Kolmogorov):
"simple" means *short generating algorithm*; by that measure many fractals are
simpler than a smooth curve, and the fractal viewpoint reveals the **recursive
developmental mechanism** behind a complex shape (the role self-similarity plays
for structure is analogous to symmetry in physics).

## Self-similarity vs symmetry
Symmetry = invariance under a **group** of congruences (rotations, reflections,
translations). Self-similarity adds **scaling**, but the maps have *different*
fixed points — e.g. the Sierpiński gasket maps onto itself under three
contractions `T1,T2,T3`, yet including their **inverses** escapes the set. So the
maps form a **semigroup**, not a group: self-similarity is *weaker* than symmetry,
but still a strong cognitive tool.

## Iterated function systems (IFS)
A planar **IFS** is a finite set of contractive affine maps `T = {T1,…,Tn}`. Its
**attractor** `A` is the unique nonempty closed set with `Ti(A) ⊆ A` for all `i`.
Because the maps contract, iterating them from *any* starting point converges to
`A`. Two rendering strategies:
- **Deterministic** — build a tree of transformation compositions and traverse
  it (breadth/depth-first); use a **non-balanced** tree (stop-criterion per
  branch) when the maps have different scaling factors, to keep points uniform.
- **Chaos game (stochastic)** — follow *one* random path, picking `Ti` with
  probability ∝ its Lipschitz (scaling) constant. Cheap and uniform.
- (Also escape-time/repelling and distance methods, which assign values to points
  *outside* `A`.)

**Barnsley's fern** — the classic IFS, four maps in homogeneous coordinates
(`[a b 0; c d 0; e f 1]`, applied as row-vector · matrix):
```
T1 = [0     0    0;  0    0.16 0;  0 0    1]   # stem
T2 = [0.20  0.23 0; -0.26 0.22 0;  0 1.60 1]   # left leaflet
T3 = [-0.15 0.26 0;  0.28 0.24 0;  0 0.44 1]   # right leaflet
T4 = [0.85 -0.04 0;  0.04 0.85 0;  0 1.60 1]   # main frond (highest probability)
```

## From an L-system to an IFS
You can convert a subapical-branching developmental L-system into an IFS. Take the
compound leaf with zero apical delay:
```
ω: A     A → F(1)[+A][-A]F(1)A     F(a) → F(a*R)   (elongating internodes)
```
and rewrite it as the equivalent **decreasing-apices** form (append shrinking
segments instead of elongating old ones):
```
ω: A(1)  A(s) → F(s)[+A(s/R)][-A(s/R)]F(s)A(s/R)
```
The construction (Fig. 8.10) is: elongating→decreasing form → recurrence on
strings → recurrence on **sets** (using `J(μ1μ2) = J(μ1) ∪ J(μ2)·M(μ1)`, where
`J` is the turtle image and `M(μ)` the transformation `μ` induces) → pass to the
limit → an equation `A(s) = J(F(2s)) ∪ A(s)(T1∪T2∪T3)` → solve → an IFS. Because
the seed is a line segment (not an arbitrary point), you either:
- generate the segment with extra maps `Q1,Q2` and forbid re-applying them via a
  **control graph** → a **controlled IFS (CIFS)** (admissible sequences = a
  regular language / finite automaton); or
- collapse the whole structure onto the segment with a **non-invertible** map `Q`
  (Barnsley's approach), scaling `y` by `(1 − 1/R)` (the limit height is the
  geometric series `2s/(1−1/R)`).

**Critical limitation.** The pivotal step (elongating → decreasing apices) is
valid only if the plant keeps **constant branching angles** and **fixed
mother/daughter proportions independent of branch order** — which requires all
segments to **elongate exponentially**. Real plants satisfy this only
approximately, so strict self-similarity is an idealization, not a literal truth.

## Takeaways for the skill
- **Self-similarity** (a semigroup of contractions), not strict fractal dimension,
  is what links plants and fractals; it exposes the recursive growth rule.
- An IFS + **chaos game** is a fast alternative renderer for self-similar plants
  (Barnsley fern matrices above copy-paste directly).
- A developmental L-system with exponential elongation and order-independent
  proportions can be mechanically turned into a (controlled) IFS; when those
  assumptions fail, prefer the L-system — it models the *development*, the IFS only
  the self-similar limit.
