# Chapter 4 — Phyllotaxis

Distilled from ABOP Ch. 4. Source:
https://algorithmicbotany.org/papers/abop/abop-ch4.lowquality.pdf
**Phyllotaxis** = the regular arrangement of lateral organs (leaves, scales,
florets). Both models here treat it as a **packing problem** and hinge on one
magic number: the golden/Fibonacci **divergence angle ≈ 137.5°**.

## The golden angle
Consecutive Fibonacci ratios `F_{k+1}/F_k → τ = (√5+1)/2`. The Fibonacci angle is
`360°·τ⁻² ≈ 137.50776°`. Spirals ("parastichies") traced through a phyllotactic
pattern come in two opposing families whose counts are **consecutive Fibonacci
numbers** (a daisy: 21 & 34; a sunflower: 34 & 55; a pineapple: 8 & 13). The
number you perceive depends on how far from the center you look (Turing's
"continuous advance" from one Fibonacci pair to the next).

> Sensitivity: 137.3° / 137.5° / 137.6° give visibly different, and mostly wrong,
> patterns — the angle must be extremely precise (Fig. 4.2). Use enough digits.

## Planar model (sunflower/daisy heads) — Vogel's formula
Floret `n` (counting outward from center) sits at polar `(φ, r)`:
```
φ = n · 137.5°        r = c·√n
```
`r ∝ √n` because equal-size florets packed in a disc make count ∝ area ∝ r².
Each new floret is issued at a fixed angle and drops into the largest existing
gap. The generating L-system (disk shape `~D`):
```
#define a 137.5
ω : A(0)
A(n) → +(a)[f(n^0.5) ~D] A(n+1)
```
For a realistic head, gate the organ shape on the index `n` (seeds → ray florets
→ petals) with conditions, e.g. a sunflower grown over 630 steps:
```
A(n) → +(137.5)[f(n^0.5) C(n)] A(n+1)
C(n): n<=440 → ~S      C(n): 440<n<=565 → ~R      … → ~M/~N/~O/~P
```
The same disk model, varying petal altitude/size/orientation with `n`, also makes
zinnias, water-lilies, and roses.

## Cylindrical model (pine/spruce cones, pineapples)
Scale `n` (from the bottom) in cylindrical coords, with constant vertical step
`h` and radius `r`:
```
φ = n·α        r = const        H = h·n
```
Generating L-system — offset the disk from the axis with `&(90)f(r)`, step up
`f(h)`, roll by the divergence angle `/(a)`:
```
#define a 137.5281   h 35.3   r 500
ω : A
A → [&(90) f(r) ~D] f(h) /(a) A
```

### Choosing α and h from the parastichy numbers (m, n)
On a cylinder the pattern is uniform; the visible parastichy pair `(m,n)`
determines `α` and `h`. Sketch of the derivation (circles packed on the cylinder):
- Angular step along an m-parastichy: `δ_m = m·α − Δ_m·2π` (Δ = encyclic number).
- Opposite directions ⇒ `n·δ_m − m·δ_n = ±2π` and `n·Δ_m − m·Δ_n = ±1` (pick the
  smallest positive integers Δ satisfying this).
- At a **triple-contact** limit (circles hexagonally packed, each tangent to six)
  `d = 2π/√(m²+mn+n²)`, giving
  `δ_m = π(m+2n)/(m²+mn+n²)`, `δ_n = π(2m+n)/(m²+mn+n²)`.
- Then recover `α` from `δ_m = mα − Δ_m·2π`, and `h` from the triangle relation.

**Construction recipe** for a `(m,n)` pattern: solve `n·Δ_m − m·Δ_n = ±1` for the
Δ's; get the admissible `δ` range from the `(m,n)` and `(min(m,n),|m−n|)` limits;
pick `δ`'s in range; compute `α`, then `h` and circle diameter `d`. A table of
triple-contact patterns gives, e.g., `(3,5,8) → α=135.918°`, `(5,8,13) → 138.140°`,
so a `(5,8)` pattern is valid for `α ∈ [135.918°, 138.140°]`.

Examples: **pineapple** uses `α=138.139542°` (scales in 5-, 8-, 13-parastichies);
**spruce cones** use `m=5, n=8, α=137.5°`. Cones/pineapples are "closed" by
shrinking the cylinder radius and scale size at top and bottom.

**Conical organs** (e.g. sedge *Carex laevigata*) reuse the cylindrical layout but
let spikelets keep growing after creation:
```
#define IRATE 1.025   SRATE 1.02
ω : A
A       → [&(5) f(1) ~M(1)] F(0.2) /(137.5) A
M(s):s<3  → M(s*SRATE)     f(s):s<3 → f(s*SRATE)
&(s):s<15 → &(s*SRATE)     F(i):i<1 → F(i*IRATE)
```

## Takeaways for the skill
- Any "spiral of organs" model is just: place organ `n`, roll by **137.5°**, step
  out (`√n` on a disc) or up (`h·n` on a cylinder). Two L-systems above cover it.
- Use many digits of 137.5° — the pattern is exquisitely sensitive.
- Parastichy counts are consecutive Fibonacci numbers; choose `(m,n)` and derive
  `α`,`h` if you need a specific cone/pineapple look.
- Gate organ shape/appearance on the index `n` (or randomize) to avoid artificial
  regularity.
