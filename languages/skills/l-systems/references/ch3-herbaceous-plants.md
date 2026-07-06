# Chapter 3 — Developmental models of herbaceous plants

Distilled from ABOP Ch. 3. Source:
https://algorithmicbotany.org/papers/abop/abop-ch3.lowquality.pdf
The heart of the book's biology: instead of drawing a final shape, you **simulate
the developmental process** so that (a) organs of different ages coexist ("phase
beauty"), and (b) the same model yields the plant at any age. Key phrase: *data
base amplification* — complex forms from a handful of productions.

## Three levels of specification
1. **Partial L-systems** — nondeterministic OL-systems that define the *space of
   possible* structures of a type (classification; no timing).
2. **L-system schemata** — add the control mechanism that resolves the
   nondeterminism (topology + timing of developmental switches).
3. **Complete L-systems** — add geometry (turtle symbols, angles, growth rates,
   organ shapes via `~` surface modules) for image synthesis.

Running example (single-flower shoot), partial form — `a` = vegetative apex,
`A` = flowering apex, `I` internode, `L` leaf, `K` flower; a *plastochron* is one
derivation step (time between internodes):
```
ω: a    a → I[L]a    a → I[L]A    A → K
```

## Control mechanisms (how a developmental switch is timed)
These are the reusable idioms — each resolves "when does `a` become `A`?":

- **Stochastic:** `a --π1--> I[L]a`, `a --π2--> I[L]A` (π1+π2=1).
- **Environment / table (TOL-systems):** swap the whole production set after some
  steps (external control picks the table) — models daylight/temperature cues.
- **Delay (counting):** apex passes through states `a₀→a₁→…→aₙ` then switches —
  some species make a fixed number of leaves before flowering.
- **Accumulation (parametric):** carry a concentration and threshold:
  ```
  a(c) : c<C → I[L]a(c+Δc)      a(c) : c≥C → I[L]A      A → K
  ```
- **Signal (context-sensitive):** a flower-inducing signal (florigen) travels from
  the base to the apex; when `S` meets `a`, it flips to `A`. Requires the signal
  to outrun the apex (delay per internode `u` < plastochron `m`). This is the
  general tool for coordinating **compound** flowering sequences.

## Branching-pattern algebra
With continuing apices `A,B,C`, terminal apex `X`, internode `I`, the four
architectures reduce to two production shapes (Table 3.1):
```
main apex TERMINATES:  A → I[B]ⁿ[X]ᵐ X      terminal (n=0,m>0),  sympodial (n>0)
main apex CONTINUES:   A → I[B]ⁿ[X]ᵐ C      monopodial (n=0,m>0), polypodial (n>0)
```
This is the single most useful classification for reading/writing plant L-systems.

## Inflorescence types (partial L-systems)
All share the vegetative preamble `a→I[L]a | a→I[L]A`; the last production sets
the type:

| type | key production | note |
|---|---|---|
| open raceme | `A → I[K]A` | monopodial; flowering always **acropetal** (base→top). Lily-of-the-valley. |
| closed raceme | add `A → K` | main apex ends in a terminal flower. Apple. |
| open cyme | `A → I[A]K` | sympodial; apex becomes a flower, lateral takes over. |
| double cyme | `A → I[A][A]K` | two continuing laterals (e.g. Lychnis coronaria). |
| closed cyme | add `A → K` | terminal flower. |
| thyrsus | cymes on a monopodial axis: `A→I[L][B]A`, `B→I[B]K`, `+ A→K`, `B→K` | mixed organization. |
| panicle (polypodial) | `A → I[L][A]A` | both main and lateral continue; highly self-similar (wall lettuce *Mycelis*). |
| umbel | `A → I[IK]ⁿ` | many internodes per node; compound = recurse `A→I[IB]ᵏB`, … |
| spike / spadix / capitulum | dense/fleshy/head racemes | sunflower head → spiral seed packing (Ch. 4). |

**Compound inflorescences** (dibotryoid, tribotryoid) stack racemes on branches
and use signals to set whether the overall sequence is **acropetal** or
**basipetal**. In the dibotryoid model, with plastochrons `m,n` and signal delays
`u,v`, the sign of `Δ = un − vm` decides the direction (Δ>0 acropetal, Δ<0
basipetal, Δ=0 simultaneous) — a clean example of the model *predicting* biology.

## Worked complete models (patterns to copy)
- **Crocus** — accumulation switch, leaves at `&(30)` spiraling by `/(137.5)`,
  organ shapes `~L(t)`/`~K(t)` grown by `L(t)→L(t+1)`, internodes elongating
  `F(l)→F(l+0.2)`.
- **Capsella bursa-pastoris** — delay switch; `%` cuts petals off at fruiting;
  leaves/flowers drawn as filled polygons `[{ . -FI(7)+FI(7)+… }]`.
- **Mycelis muralis (Models II & III)** — two different signal schemes (growth
  potential accumulated by a basipetal signal `T`, vs. the interval between two
  basipetal signals `T`,`V`) that produce the *same* basipetal, acrotonic
  sequence — showing models generate testable physiological hypotheses.
- **Lilac** — simple static model; apex roll `/(90)` gives a **decussate** pattern
  (successive branch pairs in perpendicular planes).

## Takeaways for the skill
- Model **development**, not shape: apices, internodes, plastochrons, switches.
- Pick a **control mechanism** (stochastic / table / delay / accumulation /
  signal) to time each switch; signals + context-sensitivity coordinate compound
  structures and can produce basipetal/acrotonic sequences that lineage alone
  cannot.
- Use the `A → I[B]ⁿ[X]ᵐ{X|C}` shapes to place yourself among terminal/sympodial/
  monopodial/polypodial before writing geometry.
- `~` attaches a predefined surface/organ; `/(137.5)` gives spiral phyllotaxis;
  `/(90)` decussate; `%` prunes a module.
