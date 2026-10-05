/**
 * The graded questions of an explore lab as a form, and the answers file the
 * form writes (workspace/<answers_file>, usually answers.json). No DOM.
 *
 * The lab's checks read that file, so what goes in it has to be exactly what
 * they expect: a number field is a JSON number or null, a text field a string
 * or null, a choice field the chosen choice string (or null). Keys the form
 * does not know about are left alone, and a key the learner changed in the
 * form wins over the file, while a key they did not touch keeps whatever is in
 * the file now (the editor may have changed it meanwhile).
 */

/** A file name in /workspace, nothing that walks out of it. */
export const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The file's text as an object: anything that is not a JSON object (missing, invalid, an array) is empty. */
export function parseAnswersFile(text) {
  if (typeof text !== 'string' || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * What a control holds for a field, from a raw value: the JSON value to store.
 * Empty (or only spaces) is null for text and number; a number that does not
 * parse is null; a choice outside the field's choices is null.
 */
export function fieldValue(field, raw) {
  const s = raw == null ? '' : String(raw);
  if (field.kind === 'number') {
    if (!s.trim()) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (field.kind === 'choice') return (field.choices || []).includes(s) ? s : null;
  return s.trim() === '' ? null : s;
}

/** What a control shows for a stored value (a string; '' for none or something it cannot show). */
export function displayValue(field, stored) {
  if (stored == null) return '';
  if (field.kind === 'number') return typeof stored === 'number' && Number.isFinite(stored) ? String(stored) : typeof stored === 'string' ? stored : '';
  if (field.kind === 'choice') return typeof stored === 'string' && (field.choices || []).includes(stored) ? stored : '';
  return typeof stored === 'string' ? stored : typeof stored === 'number' ? String(stored) : '';
}

/**
 * The object to write.
 *   disk     what the file holds now (an object)
 *   fields   the bundle's fields
 *   values   { key: the control's JSON value } for every field
 *   dirty    Set of keys the learner changed in the form
 * Starts from `disk` (so unknown keys survive, in their order). A field's key
 * is set from the form when the learner changed it or the file has no such
 * key yet; otherwise the file's value stays.
 */
export function mergeAnswers(disk, fields, values, dirty = new Set()) {
  const out = { ...(disk && typeof disk === 'object' && !Array.isArray(disk) ? disk : {}) };
  for (const f of fields) {
    if (dirty.has(f.key) || !Object.prototype.hasOwnProperty.call(out, f.key)) {
      out[f.key] = Object.prototype.hasOwnProperty.call(values, f.key) ? values[f.key] : null;
    }
  }
  return out;
}

/** The file text: two-space JSON and a final newline. */
export const serializeAnswers = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

/**
 * Radios read better than a select up to this many choices.
 */
export const MAX_RADIO_CHOICES = 4;

/**
 * What a question's card says about it.
 *
 *   value   the control's JSON value now (null when empty)
 *   dirty   the learner changed it and it has not been written yet
 *   result  optional per-question outcome of a check run, `{ pass: boolean }`
 *
 * 'empty' (no answer yet), 'answered' (has one, not written yet), 'saved' (has
 * one and it is in the file), and, when a check run reports on this question,
 * 'checked-correct' or 'checked-wrong'. The console's checks grade the answers
 * file as a whole today, so nothing passes a result in yet; the form takes
 * them through setResults() the day a lab's checks report per question.
 */
export function questionStatus({ value, dirty = false, result } = {}) {
  if (result && typeof result.pass === 'boolean') return result.pass ? 'checked-correct' : 'checked-wrong';
  if (value == null || value === '') return 'empty';
  return dirty ? 'answered' : 'saved';
}

/** The words on a card's badge for each status, and the badge style it wears. */
export const QUESTION_STATUS = {
  empty: { text: 'Not answered', tone: 'outline' },
  answered: { text: 'Answered', tone: 'info' },
  saved: { text: 'Saved', tone: 'ok' },
  'checked-correct': { text: 'Checked \u00b7 correct', tone: 'ok' },
  'checked-wrong': { text: 'Checked \u00b7 not yet', tone: 'warn' },
};

/** How many of the fields have an answer, from `{ key: value }`. */
export function answeredCount(fields, values) {
  let n = 0;
  for (const f of fields) {
    const v = values?.[f.key];
    if (v != null && v !== '') n++;
  }
  return n;
}

/**
 * Which answers a check run found wrong, for marking them on their own questions.
 *
 *   fields   the bundle's fields
 *   values   { key: the control's JSON value now }
 *   results  the run's check results ({ pass, message })
 *
 * The answers check names every field it found wrong (by key) in its message; the same message names the fields
 * with no answer yet after "missing an answer for:", and those are not wrong, only empty. Returns `{ key: { pass } }`:
 * every answered field passes when the whole run does, and when a failed message names some answered fields those are
 * wrong and the other answered ones right. A failure that names no field (a service down) says nothing about any.
 */
export function fieldOutcomes(fields, values, results) {
  if (!Array.isArray(results) || !results.length) return {};
  const answered = (key) => values?.[key] != null && values[key] !== '';
  const out = {};
  if (results.every((r) => r.pass)) {
    for (const f of fields) if (answered(f.key)) out[f.key] = { pass: true };
    return out;
  }
  const text = results
    .filter((r) => !r.pass)
    .map((r) => String(r.message ?? '').replace(/missing an answer for:[^\n]*/gi, ''))
    .join('\n');
  const named = fields.filter((f) => answered(f.key) && new RegExp(`(^|[^a-z0-9_])${f.key}([^a-z0-9_]|$)`).test(text));
  if (!named.length) return {};
  for (const f of fields) if (answered(f.key)) out[f.key] = { pass: !named.includes(f) };
  return out;
}
