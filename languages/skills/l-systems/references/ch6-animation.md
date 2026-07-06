# Chapter 6 — Animation of plant development

Distilled from ABOP Ch. 6. Source:
https://algorithmicbotany.org/papers/abop/abop-ch6.lowquality.pdf
How to turn a developmental L-system into a **smooth animation**. The problem:
ordinary L-systems are discrete in time (states known only at integer steps).
The solution: **timed DOL-systems**, which run development in *continuous* time
and observe it at whatever frame times you like.

## Why not just use fine time slices?
You can, but three drawbacks push toward a continuous model: the time step gets
baked into the model; smoothness (continuity) criteria are easier to state in
continuous time; and it's cleaner to separate *development* (continuous) from
*observation* (discrete frames). View development as periods of continuous module
**expansion** punctuated by instantaneous module **division** (a Thom-style
piecewise-continuous process with "catastrophes").

## Timed DOL-systems (tDOL-systems)
A **timed letter** is `(a, τ)` — letter `a` with **age** `τ ∈ ℝ⁺`. A tDOL-system
is `G = (V, ω, P)` where the axiom is a timed word and productions look like
```
(a, β) → (b₁, α₁)(b₂, α₂) … (bₙ, αₙ)
```
`β` is the **terminal age** of `a` (when it divides); each `αᵢ` is the **initial
age** given to `bᵢ`. Conditions: each letter has exactly one terminal age (C1),
and every initial age is below its terminal age so lifetimes `β−α` are positive
(C2).

Two clocks: **global time `t`** (shared) and **local age `τ`** per letter. The
derivation function `D` obeys:
- **A1** it distributes over a word (letters evolve independently — no interaction);
- **A2** `D((a,τ), t) = (a, τ+t)` while `τ+t ≤ β` (just age it);
- **A3** at `τ+t > β`, divide: continue with the successor, carrying the leftover
  time `t − (β−τ)`.

**Anabaena** in continuous time (all cells live 1 time unit):
```
ω : (a_r, 0)
(a_r,1) → (a_l,0)(b_r,0)     (a_l,1) → (b_l,0)(a_r,0)
(b_r,1) → (a_r,0)            (b_l,1) → (a_l,0)
```
Treating `b` as a young `a` simplifies to two rules with terminal age 2:
`(a_r,2) → (a_l,1)(a_r,0)`, `(a_l,2) → (a_l,0)(a_r,1)`.

**Observation independence (the key theorem):** `D(D(x,tₐ),t_b) = D(x, tₐ+t_b)` —
the derived word depends only on total elapsed time, not on how you slice it. So
you can sample frames at any `Δt` and get a consistent animation.

## Choosing growth functions for smoothness
A tDOL-system gives each module's **age**; you still need its **shape as a
function of age**, `g(a,τ)`. Pick `g` so geometry doesn't jump:
- **R1** `g(a,τ)` is continuous over the lifetime `[α_min, β]`.
- **R2** length is conserved at division: `g(a,β) = Σ g(bᵢ, αᵢ)`.
For truly smooth *growth rate* (no visible speed-up at each division), require
continuity of higher derivatives too: `g^(k)(a,β) = Σ g^(k)(bᵢ,αᵢ)`, `k=0..N`.

Worked results (nonbranching filament):
- **Linear** `g = Aτ+B` satisfies R2 (zeroth order) but the whole-structure
  growth rate kinks at each division.
- **Exponential** `g = A·e^{Bτ}` gives first-order (in fact infinite-order)
  continuity when `B = ln((1+√5)/2) ≈ 0.4812` — i.e. `B = ln(golden mean)`. `A`
  is a free scale.

**Branching structures** work the same with brackets. A compound-leaf tDOL:
```
ω : (a,0)
(a,1) → (s,0)[(b,0)][(b,0)](a,0)      (b,β) → (a,0)
```
Apices/internodes grow exponentially; a newly created lateral `b` must start at
zero length *and* zero rate, so `g(b,τ)` is a **cubic** (or higher) whose
endpoints/tangents are fixed by the continuity equations. Any OL-system with
turtle interpretation can be converted to a tDOL-system and animated this way —
and the same continuity trick applies to branching angle, segment diameter, and
surface size, not just length.

## Takeaways for the skill
- To animate development, attach an **age** to each module (`(a, τ)`), give each
  letter a **terminal age** at which it divides, and sample global time at your
  frame rate — the composition theorem guarantees consistency.
- Choose `g(a,τ)` to satisfy **length conservation at division** (R2); for
  jump-free *growth rate*, match derivatives too — exponential growth with
  `B = ln φ ≈ 0.4812` is the canonical smooth choice, with cubics for parts that
  must start at zero length and zero rate.
