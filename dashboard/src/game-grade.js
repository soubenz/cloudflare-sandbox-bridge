/**
 * The graders of the warm-up games: pure, no DOM. Each decides whether a finished answer is right
 * (games.js re-exports them; game-engine.js builds the rounds on them).
 */

/** Deterministic shuffle (mulberry32 + Fisher-Yates). Returns a new array; `seed` is a number or a string. */
export function shuffle(items, seed = 1) {
  let s = 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) s = (Math.imul(s, 31) + seed.charCodeAt(i)) | 0;
  } else {
    s = Math.trunc(Number(seed)) | 0;
  }
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = Array.from(items);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const idSet = (v) => new Set(Array.isArray(v) ? v : v instanceof Set ? [...v] : []);

/**
 * sort: `placement` maps card id to bucket id. A card with no bucket counts as wrong.
 * Returns { correct, score, total, wrong: [card ids] }.
 */
export function gradeSort(game, placement) {
  const cards = Array.isArray(game?.cards) ? game.cards : [];
  const placed = placement && typeof placement === 'object' ? placement : {};
  const wrong = cards.filter((c) => placed[c.id] !== c.bucket).map((c) => c.id);
  const score = cards.length - wrong.length;
  return { correct: wrong.length === 0, score, total: cards.length, wrong };
}

/**
 * flag: `flagged` is the ids the learner flagged (array or Set). Right when it is exactly the
 * items marked `flag`. Returns { correct, missed: [ids that should be flagged], extra: [ids flagged in error] }.
 */
export function gradeFlag(game, flagged) {
  const items = Array.isArray(game?.items) ? game.items : [];
  const chosen = idSet(flagged);
  const missed = items.filter((i) => i.flag === true && !chosen.has(i.id)).map((i) => i.id);
  const extra = items.filter((i) => i.flag !== true && chosen.has(i.id)).map((i) => i.id);
  return { correct: missed.length === 0 && extra.length === 0, missed, extra };
}

/**
 * sliders: folds `formula` left from the first input (its op is ignored). `values` maps input id to
 * a number; an input with no value uses its default. Returns a number (NaN for an unknown op or a
 * missing input; Infinity or NaN for a division by zero).
 */
export function evalFormula(game, values) {
  const formula = Array.isArray(game?.formula) ? game.formula : [];
  const inputs = Array.isArray(game?.inputs) ? game.inputs : [];
  const read = (id) => {
    const given = values?.[id];
    if (given !== undefined && given !== null && given !== '') return Number(given);
    const input = inputs.find((i) => i.id === id);
    return input ? Number(input.default) : NaN;
  };
  if (formula.length === 0) return NaN;
  let acc = read(formula[0].input);
  for (let i = 1; i < formula.length; i++) {
    const v = read(formula[i].input);
    switch (formula[i].op) {
      case '*':
        acc *= v;
        break;
      case '+':
        acc += v;
        break;
      case '-':
        acc -= v;
        break;
      case '/':
        acc /= v;
        break;
      default:
        return NaN;
    }
  }
  return acc;
}

/** sliders: the readout as text: the value to `decimals` places, then the unit ("12.5 ms", "40%"). */
export function formatReadout(game, value) {
  const r = game?.readout ?? {};
  if (!Number.isFinite(value)) return 'not a number';
  const num = value.toFixed(Math.max(0, Math.min(20, Number(r.decimals) || 0)));
  if (!r.unit) return num;
  return r.unit === '%' ? `${num}%` : `${num} ${r.unit}`;
}

/** sliders: is `choice` (an input id) the one `ask.answer` names. */
export function gradeAsk(game, choice) {
  return typeof choice === 'string' && choice !== '' && choice === game?.ask?.answer;
}

/** The answer tree of an order-and-nest game, flattened pre-order (siblings by `order`): [{ id, depth }]. */
export function outlineAnswer(game) {
  const steps = Array.isArray(game?.steps) ? game.steps : [];
  const ids = new Set(steps.map((s) => s.id));
  const kids = new Map();
  for (const s of steps) {
    // A parent that is not a step of this game is treated as the root.
    const key = s.parent && ids.has(s.parent) ? s.parent : null;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(s);
  }
  const out = [];
  const seen = new Set();
  const walk = (key, depth) => {
    const list = (kids.get(key) ?? []).slice().sort((a, b) => a.order - b.order);
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ id: s.id, depth });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * order-and-nest: `rows` is [{ id, depth }] in display order. Right when every row is the one the
 * pre-order traversal of the answer tree expects, at the depth the tree gives it.
 * Returns { correct, wrong: [row ids out of place or at the wrong depth] }.
 */
export function gradeOutline(game, rows) {
  const expected = outlineAnswer(game);
  const got = Array.isArray(rows) ? rows : [];
  const wrong = [];
  const n = Math.max(expected.length, got.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const g = got[i];
    if (!g) continue;
    if (!e || g.id !== e.id || g.depth !== e.depth) wrong.push(g.id);
  }
  return { correct: wrong.length === 0 && got.length === expected.length, wrong };
}
