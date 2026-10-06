/**
 * Warm-up games: four small interactions a learner plays before a lab.
 *
 *   sort           put each card in a bucket
 *   flag           pick every item that should be flagged
 *   sliders        move the inputs, watch a readout, answer a question about it
 *   order-and-nest put steps in order and indent them into an outline
 *
 * No drag-and-drop and no libraries: everything is a real button, radio or
 * range input, so it works from the keyboard and with a screen reader. Every
 * string goes in as text. The graders are pure and exported (the mount only
 * draws and counts tries); the learner may retry until it is right.
 *
 *   mountGame(host, game, { onResult })
 *     calls onResult({ id, solved: true, tries }) when the learner gets it right;
 *     `tries` counts the Check presses that were graded (a press with nothing
 *     chosen or a card unplaced is asked to finish first and is not a try).
 *     Returns { root, destroy }.
 */

import { make, button, questionScreen, actionBar } from './learn-ui.js';

// ---------------------------------------------------------------------------
// Pure helpers and graders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

let uid = 0;

/** The parts every game shares: root, heading, prompt, status region. */
function frame(game) {
  const id = `game${++uid}`;
  const root = make('section', 'game');
  root.dataset.kind = game.kind;
  root.dataset.game = game.id;
  const heading = make('h2', 'game-title', game.title);
  heading.tabIndex = -1;
  heading.id = `${id}-title`;
  root.setAttribute('aria-labelledby', heading.id);
  const prompt = make('p', 'game-prompt', game.prompt);
  const status = make('p', 'game-status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('role', 'status');
  return { id, root, heading, prompt, status };
}

function explainCard(game, heading = 'Solved') {
  const card = make('div', 'game-explain');
  card.append(make('strong', 'game-explain-head', heading), make('p', 'game-explain-body', game.explanation ?? ''));
  return card;
}

function say(status, text, state) {
  status.textContent = text;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function mountSort(game, ctx, onSolved) {
  const { root, status } = ctx;
  const placement = {};
  let tries = 0;
  let solved = false;

  const list = make('ul', 'game-list game-sort');
  const rows = new Map();
  for (const card of game.cards) {
    const row = make('li', 'game-card');
    row.dataset.card = card.id;
    const text = make('span', 'game-card-text', card.text);
    const group = make('div', 'game-card-buckets');
    group.setAttribute('role', 'group');
    const textId = `${ctx.id}-${card.id}`;
    text.id = textId;
    group.setAttribute('aria-labelledby', textId);
    const buttons = new Map();
    for (const b of game.buckets) {
      const btn = button(b.label, { kind: 'ghost' });
      btn.classList.add('btn-tiny', 'game-bucket');
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        if (solved) return;
        placement[card.id] = b.id;
        for (const [bid, other] of buttons) other.setAttribute('aria-pressed', String(bid === b.id));
        clearWrong();
      });
      buttons.set(b.id, btn);
      group.append(btn);
    }
    const note = make('span', 'game-card-note');
    row.append(text, group, note);
    list.append(row);
    rows.set(card.id, { row, buttons, note });
  }

  function clearWrong() {
    for (const { row, note } of rows.values()) {
      delete row.dataset.state;
      note.textContent = '';
    }
  }

  const check = button('Check', { kind: 'primary' });
  check.addEventListener('click', () => {
    if (solved) return;
    const unplaced = game.cards.filter((c) => !placement[c.id]).length;
    if (unplaced > 0) {
      say(status, `Put ${plural(unplaced, 'more card', 'more cards')} in a bucket, then check.`, 'none');
      return;
    }
    tries += 1;
    const result = gradeSort(game, placement);
    clearWrong();
    if (result.correct) {
      solved = true;
      for (const { row, buttons } of rows.values()) {
        row.dataset.state = 'right';
        for (const b of buttons.values()) b.disabled = true;
      }
      check.hidden = true;
      say(status, `Solved: ${result.score} of ${result.total}.`, 'correct');
      root.append(explainCard(game));
      onSolved(tries);
      return;
    }
    for (const id of result.wrong) {
      const r = rows.get(id);
      r.row.dataset.state = 'wrong';
      r.note.textContent = 'Not quite.';
    }
    say(status, `${result.score} of ${result.total} are in the right bucket. The outlined cards are not quite right.`, 'incorrect');
  });

  root.append(list, status, actionBar([check]));
}

function mountFlag(game, ctx, onSolved) {
  const { root, status } = ctx;
  const items = Array.isArray(game.items) ? game.items : [];
  const holder = make('div', 'game-embed');
  let tries = 0;

  const question = {
    id: `${game.id}:flag`,
    concept: game.id,
    type: 'multi',
    prompt: 'Select every item that should be flagged.',
    options: items.map((i) => ({ id: i.id, text: i.text })),
    answer: items.filter((i) => i.flag === true).map((i) => i.id),
    explanation: game.explanation ?? '',
  };

  function ask() {
    const screen = questionScreen({
      question,
      index: 0,
      total: 1,
      title: game.title,
      lastLabel: 'Try again',
      nextLabelFor: (r) => (r.correct ? 'Done' : 'Try again'),
      onAnswer(result) {
        tries += 1;
        const graded = gradeFlag(game, result.selected);
        if (graded.correct) {
          screen.next.hidden = true;
          say(status, `Solved in ${plural(tries, 'try', 'tries')}.`, 'correct');
          holder.append(whyList(items));
          onSolved(tries);
        } else {
          say(status, `Not quite: ${plural(graded.missed.length, 'item', 'items')} missed, ${plural(graded.extra.length, 'item', 'items')} flagged by mistake. Try again.`, 'incorrect');
        }
      },
      onNext(result) {
        if (result.correct) return;
        say(status, '');
        holder.replaceChildren(ask().root);
        holder.querySelector('input')?.focus();
      },
    });
    return screen;
  }

  holder.append(ask().root);
  root.append(holder, status);
}

/** After a flag game is solved: what each item was, and why it was or was not flagged. */
function whyList(items) {
  const wrap = make('div', 'game-why');
  wrap.append(make('h3', 'game-why-title', 'Why'));
  const ul = make('ul', 'game-why-list');
  for (const item of items) {
    if (!item.why) continue;
    const li = make('li', 'game-why-item');
    li.dataset.flag = item.flag === true ? 'yes' : 'no';
    li.append(make('strong', 'game-why-text', item.text), document.createTextNode(` ${item.flag === true ? '(flag)' : '(fine)'}: ${item.why}`));
    ul.append(li);
  }
  wrap.append(ul);
  return wrap;
}

function mountSliders(game, ctx, onSolved) {
  const { root, status } = ctx;
  const inputs = Array.isArray(game.inputs) ? game.inputs : [];
  const values = Object.fromEntries(inputs.map((i) => [i.id, Number(i.default)]));
  let tries = 0;

  const panel = make('div', 'game-sliders');
  const readout = make('output', 'game-readout');
  readout.setAttribute('aria-live', 'off');
  const readoutLabel = make('span', 'game-readout-label', game.readout?.label ?? 'Result');
  const readoutValue = make('strong', 'game-readout-value');
  readout.append(readoutLabel, document.createTextNode(': '), readoutValue);
  const refresh = () => {
    readoutValue.textContent = formatReadout(game, evalFormula(game, values));
  };

  for (const inp of inputs) {
    const field = make('div', 'game-slider');
    const inputId = `${ctx.id}-${inp.id}`;
    const label = make('label', 'game-slider-label', inp.label);
    label.htmlFor = inputId;
    const range = make('input', 'game-range');
    range.type = 'range';
    range.id = inputId;
    range.min = String(inp.min);
    range.max = String(inp.max);
    range.step = String(inp.step);
    range.value = String(inp.default);
    const current = make('span', 'game-slider-value');
    const show = () => {
      const text = `${range.value}${inp.unit ? (inp.unit === '%' ? '%' : ` ${inp.unit}`) : ''}`;
      current.textContent = text;
      range.setAttribute('aria-valuetext', text);
    };
    show();
    range.addEventListener('input', () => {
      values[inp.id] = Number(range.value);
      show();
      refresh();
    });
    const top = make('div', 'game-slider-top');
    top.append(label, current);
    field.append(top, range);
    panel.append(field);
  }
  refresh();
  panel.append(readout);

  const holder = make('div', 'game-embed');
  const question = {
    id: `${game.id}:ask`,
    concept: game.id,
    type: 'single',
    prompt: game.ask?.prompt ?? '',
    options: inputs.map((i) => ({ id: i.id, text: i.label })),
    answer: game.ask?.answer ? [game.ask.answer] : [],
    explanation: game.explanation ?? '',
  };

  function ask() {
    const screen = questionScreen({
      question,
      index: 0,
      total: 1,
      title: game.title,
      lastLabel: 'Try again',
      nextLabelFor: (r) => (r.correct ? 'Done' : 'Try again'),
      onAnswer(result) {
        tries += 1;
        if (gradeAsk(game, result.selected[0])) {
          screen.next.hidden = true;
          say(status, `Solved in ${plural(tries, 'try', 'tries')}.`, 'correct');
          onSolved(tries);
        } else {
          say(status, 'Not quite. Try again.', 'incorrect');
        }
      },
      onNext(result) {
        if (result.correct) return;
        say(status, '');
        holder.replaceChildren(ask().root);
        holder.querySelector('input')?.focus();
      },
    });
    return screen;
  }
  holder.append(ask().root);
  root.append(panel, holder, status);
}

function mountOutline(game, ctx, onSolved, seed) {
  const { root, status } = ctx;
  const steps = Array.isArray(game.steps) ? game.steps : [];
  const text = new Map(steps.map((s) => [s.id, s.text]));
  const answerIds = outlineAnswer(game).map((r) => r.id);

  // Shuffled for display, never left in the answer order (when there is more than one row).
  let order = shuffle(steps.map((s) => s.id), seed);
  if (order.length > 1 && order.every((id, i) => id === answerIds[i])) order = [...order.slice(1), order[0]];
  let rows = order.map((id) => ({ id, depth: 0 }));
  let tries = 0;
  let solved = false;
  let wrong = new Set();

  const list = make('ol', 'game-list game-outline');
  const check = button('Check', { kind: 'primary' });

  /** Keep the outline valid: the first row is at the top level, no row nests deeper than one under the row above. */
  function clamp() {
    rows.forEach((r, i) => {
      r.depth = i === 0 ? 0 : Math.max(0, Math.min(r.depth, rows[i - 1].depth + 1));
    });
  }

  const ACTIONS = [
    ['up', 'Up', (i) => i > 0],
    ['down', 'Down', (i) => i < rows.length - 1],
    ['indent', 'Indent', (i) => i > 0 && rows[i].depth < rows[i - 1].depth + 1],
    ['outdent', 'Outdent', (i) => rows[i].depth > 0],
  ];

  function apply(i, action) {
    const r = rows[i];
    let at = i;
    if (action === 'up') {
      [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
      at = i - 1;
    } else if (action === 'down') {
      [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
      at = i + 1;
    } else if (action === 'indent') r.depth += 1;
    else r.depth -= 1;
    clamp();
    wrong = new Set();
    render({ id: r.id, action });
    const verb = { up: 'moved up', down: 'moved down', indent: 'indented', outdent: 'outdented' }[action];
    say(status, `${text.get(r.id)} ${verb}: row ${at + 1} of ${rows.length}, level ${rows[at].depth + 1}.`);
  }

  function render(focus) {
    list.replaceChildren();
    rows.forEach((r, i) => {
      const li = make('li', 'game-row');
      li.style.setProperty('--depth', String(r.depth));
      li.dataset.id = r.id;
      if (wrong.has(r.id)) li.dataset.state = 'wrong';
      if (solved) li.dataset.state = 'right';
      const label = make('span', 'game-row-text', text.get(r.id));
      const level = make('span', 'game-row-level', `Level ${r.depth + 1}`);
      const bar = make('div', 'game-row-actions');
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', `Move: ${text.get(r.id)}`);
      for (const [action, name, allowed] of ACTIONS) {
        const b = button(name, { kind: 'ghost' });
        b.classList.add('btn-tiny');
        b.dataset.action = action;
        b.setAttribute('aria-label', `${name}: ${text.get(r.id)}`);
        b.disabled = solved || !allowed(i);
        b.addEventListener('click', () => apply(rows.indexOf(r), action));
        bar.append(b);
      }
      li.append(label, level, bar);
      list.append(li);
    });
    if (focus) {
      const li = list.querySelector(`[data-id="${CSS.escape(focus.id)}"]`);
      const target = li?.querySelector(`[data-action="${focus.action}"]:not(:disabled)`) ?? li?.querySelector('button:not(:disabled)');
      target?.focus();
    }
  }

  check.addEventListener('click', () => {
    if (solved) return;
    tries += 1;
    const result = gradeOutline(game, rows);
    if (result.correct) {
      solved = true;
      check.hidden = true;
      render();
      say(status, `Solved in ${plural(tries, 'try', 'tries')}.`, 'correct');
      root.append(explainCard(game));
      onSolved(tries);
      return;
    }
    wrong = new Set(result.wrong);
    render();
    say(status, `Not quite: ${plural(result.wrong.length, 'row is', 'rows are')} out of place or at the wrong level.`, 'incorrect');
  });

  clamp();
  render();
  const hint = make('p', 'game-hint', 'Use Up and Down to reorder. Indent nests a step under the one above it; Outdent moves it back out.');
  root.append(hint, list, status, actionBar([check]));
}

/**
 * Draws `game` into `host` (replacing what was there). `onResult({ id, solved: true, tries })`
 * is called each time the learner solves it. Returns { root, destroy }.
 */
export function mountGame(host, game, { onResult } = {}) {
  const ctx = frame(game);
  const onSolved = (tries) => onResult?.({ id: game.id, solved: true, tries });
  ctx.root.append(ctx.heading, ctx.prompt);
  switch (game.kind) {
    case 'sort':
      mountSort(game, ctx, onSolved);
      break;
    case 'flag':
      mountFlag(game, ctx, onSolved);
      break;
    case 'sliders':
      mountSliders(game, ctx, onSolved);
      break;
    case 'order-and-nest':
      mountOutline(game, ctx, onSolved, Date.now());
      break;
    default: {
      const note = make('p', 'game-status', 'This game is not available in this version of the console.');
      ctx.root.append(note);
    }
  }
  host.replaceChildren(ctx.root);
  return {
    root: ctx.root,
    destroy() {
      ctx.root.remove();
    },
  };
}
