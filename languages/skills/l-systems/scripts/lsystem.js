/*
 * lsystem.js — a small, dependency-free L-system engine.
 * Expand a Lindenmayer system and render it with a 2D turtle to SVG.
 * Mirrors scripts/lsystem.py; based on ABOP Ch. 1
 * (http://algorithmicbotany.org/papers/#abop).
 *
 * Works in two places:
 *   - the tbjs `run_js` sandbox — call demo(name) or render(spec) and log the SVG;
 *   - an HTML artifact — paste these functions and set svgEl.outerHTML = render(spec).
 *
 * Supports deterministic & stochastic context-free productions and bracketed
 * branching. (Context-sensitive matching lives in the Python engine.)
 *
 * Rules shape (object keyed by predecessor symbol):
 *   { "F": "F+F-F" }                      deterministic
 *   { "F": [["F[+F]F", 1/2], ["F[-F]F", 1/2]] }   weighted stochastic
 * Turtle symbols: F G draw, f g move, + - turn by angle (ABOP: + = left/CCW),
 *   | turn 180, [ ] push/pop, ! thinner, ' next colour. Unknown letters: no-op.
 */

// ---- deterministic RNG so stochastic output is reproducible with a seed ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSuccessor(alts, rng) {
  // alts: array of [successor, weight]
  if (alts.length === 1) return alts[0][0];
  const total = alts.reduce((s, a) => s + a[1], 0);
  let r = rng() * total;
  for (const [succ, w] of alts) { r -= w; if (r <= 0) return succ; }
  return alts[alts.length - 1][0];
}

function normaliseRules(rules) {
  const out = {};
  for (const [pred, spec] of Object.entries(rules)) {
    if (typeof spec === "string") out[pred] = [[spec, 1]];
    else out[pred] = spec.map((it) => (typeof it === "string" ? [it, 1] : it));
  }
  return out;
}

/** Expand the axiom by applying productions in parallel n times. */
function expand(axiom, rules, n, seed = 0) {
  const table = normaliseRules(rules);
  const rng = mulberry32(seed);
  let s = axiom;
  for (let step = 0; step < n; step++) {
    let out = "";
    for (const c of s) out += table[c] ? pickSuccessor(table[c], rng) : c;
    s = out;
  }
  return s;
}

const DEFAULT_PALETTE = ["#2f6d3c", "#3f8a4e", "#7bb661", "#b5651d", "#8a5a2b"];

/** Interpret an expanded string with a 2D turtle and return an SVG string. */
function renderSVG(s, opts = {}) {
  const {
    angle = 25, step = 10, startHeading = 90, width = 1.6, widthDelta = 0.7,
    palette = DEFAULT_PALETTE, background = null, pad = 8,
    drawSymbols = "FG", moveSymbols = "fg",
  } = opts;

  let x = 0, y = 0, h = startHeading, w = width, ci = 0;
  const stack = [];
  const segs = []; // [x1,y1,x2,y2,width,colourIndex]

  for (const c of s) {
    if (drawSymbols.includes(c) || moveSymbols.includes(c)) {
      const rad = (h * Math.PI) / 180;
      const nx = x + step * Math.cos(rad);
      const ny = y + step * Math.sin(rad);
      if (drawSymbols.includes(c)) segs.push([x, y, nx, ny, w, ci]);
      x = nx; y = ny;
    } else if (c === "+") h += angle;
    else if (c === "-") h -= angle;
    else if (c === "|") h += 180;
    else if (c === "[") stack.push([x, y, h, w, ci]);
    else if (c === "]") { if (stack.length) [x, y, h, w, ci] = stack.pop(); }
    else if (c === "!") w = Math.max(0.1, w - widthDelta);
    else if (c === "'") ci += 1;
  }

  if (!segs.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

  const xs = segs.flatMap((s) => [s[0], s[2]]);
  const ys = segs.flatMap((s) => [s[1], s[3]]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const W = maxx - minx + 2 * pad, H = maxy - miny + 2 * pad;
  const fx = (v) => (v - minx + pad).toFixed(2);
  const fy = (v) => (maxy - v + pad).toFixed(2); // flip y for screen coords

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(1)}" height="${H.toFixed(1)}" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}">`,
  ];
  if (background) parts.push(`<rect width="100%" height="100%" fill="${background}"/>`);
  parts.push('<g stroke-linecap="round" fill="none">');
  for (const [x1, y1, x2, y2, sw, col] of segs) {
    parts.push(`<line x1="${fx(x1)}" y1="${fy(y1)}" x2="${fx(x2)}" y2="${fy(y2)}" stroke="${palette[col % palette.length]}" stroke-width="${sw.toFixed(2)}"/>`);
  }
  parts.push("</g></svg>");
  return parts.join("\n");
}

// ---- a few canonical systems from ABOP (see lsystem.py for the full set) ----
const DEMOS = {
  koch_island: { axiom: "F-F-F-F", rules: { F: "F-F+F+FF-F-F+F" }, n: 2, angle: 90, startHeading: 0, step: 10 },
  dragon: { axiom: "FX", rules: { X: "X+YF+", Y: "-FX-Y" }, n: 11, angle: 90, startHeading: 0, step: 6 },
  hilbert: { axiom: "A", rules: { A: "-BF+AFA+FB-", B: "+AF-BFB-FA+" }, n: 5, angle: 90, startHeading: 0, step: 8 },
  plant_a: { axiom: "F", rules: { F: "F[+F]F[-F]F" }, n: 5, angle: 25.7, startHeading: 90, step: 6 },
  plant_f: { axiom: "X", rules: { X: "F-[[X]+X]+F[+FX]-X", F: "FF" }, n: 5, angle: 22.5, startHeading: 90, step: 6 },
  stochastic_bush: { axiom: "F", rules: { F: [["F[+F]F[-F]F", 1 / 3], ["F[+F]F", 1 / 3], ["F[-F]F", 1 / 3]] }, n: 5, angle: 25.7, startHeading: 90, step: 6 },
};

function demo(name) {
  const d = DEMOS[name];
  if (!d) throw new Error(`unknown demo ${name}; choose: ${Object.keys(DEMOS).join(", ")}`);
  const final = expand(d.axiom, d.rules, d.n, d.seed || 0);
  return renderSVG(final, d);
}

/** Render from a spec object { axiom, rules, n, angle, step, startHeading, ... }. */
function render(spec) {
  const final = expand(spec.axiom, spec.rules, spec.n ?? 4, spec.seed || 0);
  return renderSVG(final, spec);
}

// Export for module consumers; harmless in a browser/tbjs where module is undefined.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { expand, renderSVG, render, demo, DEMOS };
}
