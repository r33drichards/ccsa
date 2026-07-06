# Chapter 7 — Modeling of cellular layers (map & cellwork L-systems)

Distilled from ABOP Ch. 7. Source:
https://algorithmicbotany.org/papers/abop/abop-ch7.lowquality.pdf
A **different formalism** from the rest of the book. String L-systems model
filaments; bracketed ones model trees; but cellular layers (fern gametophytes,
epidermis, animal blastulae) are **planar graphs with cycles**. Those need **map
L-systems**, a *parallel graph-rewriting* system. Two stages: (1) rewrite the
**topology** of cell divisions; (2) compute cell **geometry** with a dynamic
mass-spring/pressure model. `scripts/lsystem.py` does **not** implement this
formalism — it is here for completeness and as a pointer if you need cellular
tessellations.

## Maps
A **map** is a finite set of **regions** (cells), each bounded by a circular
sequence of **edges** (walls) meeting at vertices. Edges don't cross without a
vertex; the edge set is connected; no islands. It's a microscopic top-down view
of a single cell layer.

## mBPMOL-systems (the map L-system used here)
**marker Binary Propagating Map OL-system.** Decoded: *map OL* = parallel,
context-free (regions rewrite independently); *Binary* = a region splits into ≤2;
*Propagating* = edges never erased (cells can't fuse or die); *markers* = flags
marking where a dividing wall attaches (their biological counterpart is the
preprophase band of microtubules).

Defined by an edge alphabet `Σ`, a starting map `ω`, and **edge productions**
`A → α`. In `α`, symbols outside brackets give the edge's **subdivision pattern**;
matching `[ … ]` delimit **markers**. Edges may be **directed** (arrow) or
**neutral**; an arrow on a successor edge says whether its direction agrees with
or opposes the predecessor. A marker's bracket holds `+`/`−` (placed left/right of
the edge) then the marker label (optionally arrowed toward/away from the edge).

Example production: `A → D C [−E] B F` subdivides directed edge `A` into four
edges and drops a marker `E` to its right.

**Derivation (two phases):**
1. Replace every edge by its successor edges + markers.
2. Scan each region for **matching markers** and join a matching pair into a new
   dividing edge.

Two markers **match** iff they're in the same region, share a label, and one
points toward its edge while the other points away (or both are neutral). The
search stops at the first match (so the system is effectively **nondeterministic**
— it picks which pair to connect); unused markers are discarded.

Small example (alternating horizontal/vertical divisions; `p2` is a delay):
```
ω : ABAB      A → B[-A][+A]B      B → A
```
Inserting an edge `x` between the markers (`A → B[-A]x[+A]B`) offsets the new
walls, producing the **Z-offsets** and **S-offsets** seen between real cells.
Directed-edge systems can produce spirals.

## Geometric interpretation (turning topology into shapes)
Maps are purely topological; three ways to place vertices:
- **Equal-length wall subdivision** (Siero et al.) — simple, but gives unnatural
  cell shapes.
- **Center-of-gravity** (de Does & Lindenmayer) — each interior vertex at the
  centroid of its neighbors (minimizes wall forces); needs an ad-hoc outward push
  on perimeter vertices, and jumps at divisions, so it's poor for animation.
- **Dynamic method (the good one)** — a mass-spring network:
  - vertices = masses; walls = straight **Hooke's-law springs** `F_s = −k(l−l₀)`;
  - each cell pushes on its walls with pressure `p·l` split between wall vertices,
    **normal** to the wall, with **osmotic pressure `p ∝ 1/A`** (from `p = SRT`,
    volume ∝ area). Polygon area `A = ½|Σ(xᵢ−xᵢ₊₁)(yᵢ+yᵢ₊₁)|`;
  - motion is **damped** (`F_d = −b·v`); no gravity/friction.
  Total force `F_T = Σ_w F_w + F_d`; integrate Newton's law with **forward Euler**
  until all increments fall below threshold (equilibrium), then perform the next
  division. New vertices split walls into equal segments with zero initial
  velocity, which preserves shape continuity across divisions — the same
  "continuous expansion punctuated by instantaneous division" idea as Ch. 6.

## Worked biology
- **Microsorium linguaeforme** (fern gametophyte): apex makes segments
  alternately left/right (`AL → SL | AR`, `AR → AL | SR`), each segment divides
  by **periclinal** (∥ apical front) and **anticlinal** (⊥) walls on a recursive
  schedule, captured by a labeled map L-system (Fig. 7.10/7.12). Lowercase = the
  mirror-image left-side productions.
- **Dryopteris thelypteris**: same apex scheme, different segment cell-division
  cycle → a different (concave/heart-shaped) thallus.
- **Periclinal ratio `P/A`** (de Boer) quantifies local→global shape: `P/A < 1.25`
  → convex front (Microsorium); `P/A > 2.0` → concave front (Dryopteris).
- **Spherical layers** (animal embryos, *Patella vulgata*): run the same
  mBPMOL-system on a sphere — walls become great-circle arcs, and displaced
  vertices are projected back onto the sphere; cells don't expand during cleavage.

## 3D: cellwork L-systems (mBPCOL-systems)
For true 3D structures, **cellworks** generalize maps: cells bounded by **walls
(faces)**, walls bounded by **edges**, edges by vertices. An **mBPCOL-system**
adds a wall alphabet `Γ`; productions are `A : β → α` where `β` lists the walls
the edge production applies to (`*` = all). **Three-phase** derivation: subdivide
edges (+ markers) → matching markers split walls (with consistent daughter-wall
labels) → a closed cycle of new edges with a consistent label creates a new wall
that splits a **cell** (a cell divides at most once per step). Geometry uses the
same dynamic method in 3D (`p ∝ 1/V`, volume by tetrahedralization; walls as flat
polygons). Used for epidermal cell patterns.

## Takeaways for the skill
- Cellular layers ≠ string L-systems: use **map L-systems** (parallel graph
  rewriting) — regions split via **markers** that must match inside a region to
  form a dividing wall; **directed** edges + **offsets** (Z/S) shape the pattern.
- Recover realistic cell shapes with the **dynamic** model: springs (Hooke) +
  osmotic pressure (`p ∝ 1/area` or `1/volume`) + damping, integrated to
  equilibrium between divisions.
- 3D → **cellwork L-systems** (mBPCOL); spheres → run maps on a sphere and project
  vertices back. This is beyond the bundled engine; reach for a dedicated
  map-L-system implementation if you need it.
