#!/usr/bin/env python3
"""A small, correct L-system engine: expand a Lindenmayer system and render it
with a 2D turtle to SVG.

Based on the formalism in P. Prusinkiewicz & A. Lindenmayer, *The Algorithmic
Beauty of Plants* (ABOP), Chapter 1 -- http://algorithmicbotany.org/papers/#abop

Supports, for the ordinary (non-parametric) case:
  * deterministic context-free productions   (D0L systems)
  * stochastic productions with weights       (section 1.7)
  * (k,l) context-sensitive productions        (IL systems, section 1.8) via a
    linear, ignore-aware matcher -- correct for non-branching signals and
    simple cases; see references/formalism.md for the full tree semantics
  * bracketed branching  [ ]                   (section 1.6)

Turtle alphabet (2D), all step / angle sizes configurable:
  F G   move forward a step, drawing a line
  f g   move forward a step WITHOUT drawing
  + -   turn left / right by the turn angle (ABOP: + is counter-clockwise)
  |     turn around (180 deg)
  [ ]   push / pop turtle state (start / end a branch)
  ! '   decrease line width / advance the colour index (see --palette)
  any other symbol is a no-op that neither moves nor turns.

Rules are given as a dict keyed by the predecessor symbol.  Each value may be:
  "FF+F"                      deterministic successor (context-free)
  ["A", "B"]                  equal-probability stochastic choice
  [("A", 0.7), ("B", 0.3)]    weighted stochastic choice
  [{"succ": "B", "left": "A", "right": "C", "weight": 1.0}, ...]  full form
                              (left / right are the context, weight optional)

Run `python lsystem.py --demo plant_a` for a worked example, or pass a JSON
spec on stdin / via --spec.  See the __main__ block for the JSON shape.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from dataclasses import dataclass


# --------------------------------------------------------------------------- #
# Rewriting
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Production:
    pred: str
    succ: str
    left: str = ""
    right: str = ""
    weight: float = 1.0


def _normalise_rules(rules: dict) -> dict[str, list[Production]]:
    """Turn the friendly rule shapes above into lists of Production objects."""
    out: dict[str, list[Production]] = {}
    for pred, spec in rules.items():
        prods: list[Production] = []
        if isinstance(spec, str):
            prods.append(Production(pred, spec))
        else:  # a list of alternatives
            for item in spec:
                if isinstance(item, str):
                    prods.append(Production(pred, item))
                elif isinstance(item, (list, tuple)):
                    succ, weight = item[0], (item[1] if len(item) > 1 else 1.0)
                    prods.append(Production(pred, succ, weight=float(weight)))
                elif isinstance(item, dict):
                    prods.append(
                        Production(
                            pred,
                            item["succ"],
                            item.get("left", ""),
                            item.get("right", ""),
                            float(item.get("weight", 1.0)),
                        )
                    )
                else:
                    raise ValueError(f"bad production for {pred!r}: {item!r}")
        out[pred] = prods
    return out


def _neighbours(s: str, i: int, ignore: set[str], direction: int, k: int) -> str:
    """Return up to k symbols on one side of index i (reading order), skipping
    symbols in `ignore`.  direction is -1 for left, +1 for right."""
    got: list[str] = []
    j = i + direction
    while 0 <= j < len(s) and len(got) < k:
        c = s[j]
        if c not in ignore:
            got.append(c)
        j += direction
    if direction < 0:
        got.reverse()  # left neighbours back into reading order
    return "".join(got)


def _matches(prod: Production, s: str, i: int, ignore: set[str]) -> bool:
    if prod.left:
        if _neighbours(s, i, ignore, -1, len(prod.left)) != prod.left:
            return False
    if prod.right:
        if _neighbours(s, i, ignore, +1, len(prod.right)) != prod.right:
            return False
    return True


def _choose(prods: list[Production], rng: random.Random) -> Production:
    if len(prods) == 1:
        return prods[0]
    total = sum(p.weight for p in prods)
    r = rng.uniform(0, total)
    upto = 0.0
    for p in prods:
        upto += p.weight
        if r <= upto:
            return p
    return prods[-1]


def expand(
    axiom: str, rules: dict, n: int, *, ignore: str = "+-[]!'", seed: int | None = None
) -> str:
    """Apply the productions in parallel `n` times, ABOP-style."""
    table = _normalise_rules(rules)
    ignore_set = set(ignore)
    rng = random.Random(seed)
    s = axiom
    for _ in range(n):
        out: list[str] = []
        for i, c in enumerate(s):
            prods = [p for p in table.get(c, []) if _matches(p, s, i, ignore_set)]
            if prods:
                out.append(_choose(prods, rng).succ)
            else:
                out.append(c)  # identity production
        s = "".join(out)
    return s


# --------------------------------------------------------------------------- #
# 2D turtle -> SVG
# --------------------------------------------------------------------------- #
@dataclass
class TurtleState:
    x: float = 0.0
    y: float = 0.0
    heading: float = 90.0  # degrees; 0 = +x (east), 90 = +y (up)
    width: float = 1.0
    colour: int = 0


DEFAULT_PALETTE = ["#2f6d3c", "#3f8a4e", "#7bb661", "#b5651d", "#8a5a2b"]


def render_svg(
    s: str,
    *,
    angle: float = 25.0,
    step: float = 10.0,
    start_heading: float = 90.0,
    width: float = 1.6,
    width_delta: float = 0.7,
    palette: list[str] | None = None,
    background: str | None = None,
    pad: float = 8.0,
    draw_symbols: str = "FG",
    move_symbols: str = "fg",
) -> str:
    """Interpret an expanded string and return a standalone SVG document.

    Geometry is computed in math coordinates (y up) and flipped on output so the
    picture is upright.  Returns the SVG as a string.
    """
    palette = palette or DEFAULT_PALETTE
    st = TurtleState(heading=start_heading, width=width)
    stack: list[TurtleState] = []
    # segments: (x1, y1, x2, y2, width, colour_index)
    segments: list[tuple[float, float, float, float, float, int]] = []

    def clone(state: TurtleState) -> TurtleState:
        return TurtleState(state.x, state.y, state.heading, state.width, state.colour)

    for c in s:
        if c in draw_symbols or c in move_symbols:
            rad = math.radians(st.heading)
            nx = st.x + step * math.cos(rad)
            ny = st.y + step * math.sin(rad)
            if c in draw_symbols:
                segments.append((st.x, st.y, nx, ny, st.width, st.colour))
            st.x, st.y = nx, ny
        elif c == "+":
            st.heading += angle
        elif c == "-":
            st.heading -= angle
        elif c == "|":
            st.heading += 180.0
        elif c == "[":
            stack.append(clone(st))
        elif c == "]":
            if stack:
                st = stack.pop()
        elif c == "!":
            st.width = max(0.1, st.width - width_delta)
        elif c == "'":
            st.colour += 1
        # everything else: no-op

    if not segments:
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>'
        )

    xs = [x for seg in segments for x in (seg[0], seg[2])]
    ys = [y for seg in segments for y in (seg[1], seg[3])]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    w = (maxx - minx) + 2 * pad
    h = (maxy - miny) + 2 * pad

    def fx(x: float) -> float:
        return x - minx + pad

    def fy(y: float) -> float:  # flip y for screen coordinates
        return (maxy - y) + pad

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.1f}" '
        f'height="{h:.1f}" viewBox="0 0 {w:.1f} {h:.1f}">'
    ]
    if background:
        parts.append(f'<rect width="100%" height="100%" fill="{background}"/>')
    parts.append('<g stroke-linecap="round" fill="none">')
    for x1, y1, x2, y2, sw, ci in segments:
        col = palette[ci % len(palette)]
        parts.append(
            f'<line x1="{fx(x1):.2f}" y1="{fy(y1):.2f}" '
            f'x2="{fx(x2):.2f}" y2="{fy(y2):.2f}" '
            f'stroke="{col}" stroke-width="{sw:.2f}"/>'
        )
    parts.append("</g></svg>")
    return "\n".join(parts)


# --------------------------------------------------------------------------- #
# A few canonical systems from ABOP for quick demos / self-test
# --------------------------------------------------------------------------- #
DEMOS: dict[str, dict] = {
    # Fig 1.7a quadratic Koch island
    "koch_island": dict(
        axiom="F-F-F-F", rules={"F": "F-F+F+FF-F-F+F"}, n=2, angle=90, start_heading=0, step=10
    ),
    # von Koch snowflake
    "snowflake": dict(
        axiom="F--F--F", rules={"F": "F+F--F+F"}, n=3, angle=60, start_heading=0, step=10
    ),
    # Sierpinski gasket (FASS)
    "sierpinski": dict(
        axiom="F-G-G", rules={"F": "F-G+F+G-F", "G": "GG"}, n=5, angle=120, start_heading=0, step=8
    ),
    # Dragon curve
    "dragon": dict(
        axiom="FX", rules={"X": "X+YF+", "Y": "-FX-Y"}, n=11, angle=90, start_heading=0, step=6
    ),
    # Hilbert space-filling curve
    "hilbert": dict(
        axiom="A",
        rules={"A": "-BF+AFA+FB-", "B": "+AF-BFB-FA+"},
        n=5,
        angle=90,
        start_heading=0,
        step=8,
    ),
    # Gosper / flowsnake curve (A and B are both drawn)
    "gosper": dict(
        axiom="A",
        rules={"A": "A-B--B+A++AA+B-", "B": "+A-BB--B-A++A+B"},
        n=4,
        angle=60,
        start_heading=0,
        step=8,
        draw_symbols="AB",
    ),
    # Fig 1.24 plants (bracketed OL-systems)
    "plant_a": dict(
        axiom="F", rules={"F": "F[+F]F[-F]F"}, n=5, angle=25.7, start_heading=90, step=6
    ),
    "plant_b": dict(
        axiom="F", rules={"F": "F[+F]F[-F][F]"}, n=5, angle=20, start_heading=90, step=6
    ),
    "plant_c": dict(
        axiom="F", rules={"F": "FF-[-F+F+F]+[+F-F-F]"}, n=4, angle=22.5, start_heading=90, step=8
    ),
    "plant_d": dict(
        axiom="X", rules={"X": "F[+X]F[-X]+X", "F": "FF"}, n=7, angle=20, start_heading=90, step=4
    ),
    "plant_e": dict(
        axiom="X", rules={"X": "F[+X][-X]FX", "F": "FF"}, n=7, angle=25.7, start_heading=90, step=4
    ),
    "plant_f": dict(
        axiom="X",
        rules={"X": "F-[[X]+X]+F[+FX]-X", "F": "FF"},
        n=5,
        angle=22.5,
        start_heading=90,
        step=6,
    ),
    # Fig 1.27 stochastic bush (equal thirds)
    "stochastic_bush": dict(
        axiom="F",
        rules={"F": [("F[+F]F[-F]F", 1 / 3), ("F[+F]F", 1 / 3), ("F[-F]F", 1 / 3)]},
        n=5,
        angle=25.7,
        start_heading=90,
        step=6,
        seed=7,
    ),
}


def run_demo(name: str) -> str:
    if name not in DEMOS:
        raise SystemExit(f"unknown demo {name!r}; choose from {', '.join(DEMOS)}")
    spec = dict(DEMOS[name])
    n = spec.pop("n")
    render_keys = (
        "angle",
        "step",
        "start_heading",
        "width",
        "background",
        "draw_symbols",
        "move_symbols",
        "width_delta",
        "palette",
        "pad",
    )
    render_kwargs = {k: spec.pop(k) for k in list(spec) if k in render_keys}
    seed = spec.pop("seed", None)
    final = expand(spec["axiom"], spec["rules"], n, seed=seed)
    return render_svg(final, **render_kwargs)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="Expand and render an L-system to SVG.")
    ap.add_argument("--demo", help="render a built-in example: " + ", ".join(DEMOS))
    ap.add_argument("--spec", help="path to a JSON spec (see module docstring)")
    ap.add_argument("--out", "-o", help="write SVG here (default: stdout)")
    ap.add_argument(
        "--string", action="store_true", help="print the expanded string instead of SVG"
    )
    args = ap.parse_args()

    if args.demo:
        svg = run_demo(args.demo)
    else:
        raw = open(args.spec).read() if args.spec else sys.stdin.read()
        spec = json.loads(raw)
        n = spec.get("n", spec.get("iterations", 4))
        seed = spec.get("seed")
        final = expand(
            spec["axiom"], spec["rules"], n, ignore=spec.get("ignore", "+-[]!'"), seed=seed
        )
        if args.string:
            print(final)
            return
        render_keys = {
            "angle",
            "step",
            "start_heading",
            "width",
            "width_delta",
            "palette",
            "background",
            "pad",
        }
        rk = {k: spec[k] for k in spec if k in render_keys}
        svg = render_svg(final, **rk)

    if args.string and args.demo:  # allow --demo --string too
        spec = dict(DEMOS[args.demo])
        n = spec.pop("n")
        seed = spec.pop("seed", None)
        print(expand(spec["axiom"], spec["rules"], n, seed=seed)[:2000])
        return

    if args.out:
        with open(args.out, "w") as fh:
            fh.write(svg)
        print(f"wrote {args.out} ({len(svg)} bytes)", file=sys.stderr)
    else:
        print(svg)


if __name__ == "__main__":
    main()
