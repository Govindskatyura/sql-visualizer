// Deterministic colors keyed by relation name.
//
// The previous version generated a random RGB per table inside the render pass
// and pushed it into state, so colors changed on every keystroke and all but
// the last table in a statement were dropped. Hashing the name instead means a
// table keeps its color for the life of the script, with no state at all.

const GOLDEN_ANGLE = 137.508;

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Stable hue in [0, 360) for a relation name. */
export function hueFor(name) {
  return (hash(String(name ?? "").toLowerCase()) * GOLDEN_ANGLE) % 360;
}

export function colorFor(name, { saturation = 62, lightness = 45 } = {}) {
  return `hsl(${hueFor(name).toFixed(1)}, ${saturation}%, ${lightness}%)`;
}

/** Muted variant for backgrounds behind text. */
export function tintFor(name, alpha = 0.16) {
  return `hsla(${hueFor(name).toFixed(1)}, 62%, 45%, ${alpha})`;
}

export const KIND_COLORS = {
  table: "#334155",
  cte: "#7c3aed",
  derived: "#0f766e",
  subquery: "#a16207",
  result: "#be123c",
};

export const KIND_LABELS = {
  table: "table",
  cte: "CTE",
  derived: "created",
  subquery: "subquery",
  result: "result",
};
