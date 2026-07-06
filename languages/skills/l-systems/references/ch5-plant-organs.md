# Chapter 5 — Models of plant organs

Distilled from ABOP Ch. 5. Source:
https://algorithmicbotany.org/papers/abop/abop-ch5.lowquality.pdf
How leaves and petals get their **surfaces**. Three approaches, from rigid to
fully developmental. This chapter pins down the exact turtle semantics for
polygons (`{ } .`) and predefined surfaces (`~`) that the plant models elsewhere
rely on.

## 1. Predefined surfaces (`~`)
Design a surface once as **bicubic patches** (each coordinate a bicubic
polynomial in `s,t`; complex surfaces = several patches) and attach it by
extending the alphabet with a surface symbol preceded by a tilde. When the turtle
hits `~S`, it draws surface `S`, translated so its contact point meets the
turtle's position and rotated to align the surface's heading/up vectors with the
turtle's. Used for most organs in the book (sunflower/zinnia/rose petals of
Ch. 4). Textures can be mapped onto these surfaces. Limitation: predefined
surfaces do **not** change shape as the plant grows.

## 2. Developmental surface models (grown polygons)
To make a surface *develop*, trace its boundary with the turtle and fill it.

**Polygon symbols (authoritative semantics):**
| symbol | action |
|---|---|
| `{` | start a new polygon (push current polygon on a stack, begin an empty one) |
| `.` | append the turtle's current position as a polygon vertex |
| `}` | fill/emit the current polygon, then pop the previous one off the stack |

Nesting is allowed (hence the stack) — you can interleave vertices of several
polygons. `G` is a "move forward, draw the segment, but **don't** treat it as a
polygon edge" letter — used to build a **framework/tree** whose marked positions
(`.`) become the polygon vertices, rather than every forward move being an edge.

**Boundary-tracing leaf** (fill a closed contour; grow edges linearly):
```
ω : L
L → { -FX+X-FX-|-FX+X+FX }      X → FX          (δ=20°, a fern leaf)
```
Boundary tracing works well only for small flat blades.

**Framework leaf** (tree skeleton + vertices marked by `.`) — cordate leaf:
```
ω : [A][B]
A → [+A{.].C.}      B → [-B{.].C.}      C → GC
```
The blade is built as a union of **triangles/trapezoids** (better than one
polygon when it bends under tropism). Phase effect: axes made first (near the
midrib) are longest.

**Parametric simple-leaf family** — one model, six shapes via Table 5.1:
```
#define LA 5  RA 1  LB 1  RB 1  PD 1
ω : {.A(0)}
A(t) → G(LA,RA)[-B(t).][A(t+1)][+B(t).]      (main axis + L/R laterals)
B(t): t>0 → G(LB,RB)B(t-PD)                  (t = branch "growth potential")
G(s,r) → G(s*r,r)                            (elongation)
```
Shape control: `PD` sets where the widest point falls; `RA` vs `RB` makes the
apical edges straight (`=`), concave (`RA<RB`), or convex (`RA>RB`). A rose leaf
(Fig. 5.8) adds a second parameter for **margin notches** and tropism-bent midrib.

**Nested-polygon flower** (lily-of-the-valley) — two framework lines with
interleaved vertices form a mesh of trapezoids:
```
ω : [X(36)A]/(72)[X(36)B]
A → [&GA{.].      B → B&.G.}      X(a) → X(a+4.5)
```

## 3. Compound leaves (self-similar branching)
When individual surfaces are tiny, what matters is the **proportion** between
young and old parts — a recursive branching L-system with an apical **delay**:
```
#define D 1  R 1.5
ω : A(0)
A(d): d>0 → A(d-1)                       (delay daughters D steps behind mother)
A(d): d=0 → F(1)[+A(D)][-A(D)]F(1)A(0)
F(a) → F(a*R)                            (elongate → sets proportions)
```
Table 5.2 (`D`,`R`) sweeps the look; wild-carrot leaves ≈ this with `D=1,R=1.5`.
An **alternating** variant swaps between two apices `A`/`B` so laterals issue
left, then right. These models are *sensitive*: a 0.01 change in growth rate
visibly alters proportions.

## Takeaways for the skill
- `~X` = attach a predefined (bicubic) surface, oriented to the turtle.
- `{ . }` = build/fill a polygon from marked turtle positions; nesting uses a
  polygon stack; `G` builds framework segments that are *not* polygon edges.
- Grow a surface by elongating its framework segments over derivation steps — the
  "phase effect" (older parts larger) falls out for free.
- For lacy compound leaves, use recursive `[+A(D)]…[-A(D)]` with an apical delay
  `D` and elongation rate `R` to control proportion.
