/**
 * The "Questions" tab of an explore lab: the graded questions as a form that
 * writes the lab's answers file (workspace/answers.json) instead of asking
 * the learner to edit JSON by hand. The lab's checks read that file exactly
 * as before.
 *
 *   - opens by reading the file (missing or invalid reads as empty)
 *   - every change is written back after ~600 ms of quiet, and "Save" writes
 *     at once; the status says Saved, Saving… or what went wrong
 *   - a write is: read the file again, merge, write. The keys the learner
 *     changed here win; keys they did not touch keep what the file holds now
 *     (the editor may have changed them), and keys the form does not know stay
 *   - "Run checks" first saves anything pending, then runs the console's own
 *     check action
 *
 * The pure half (what goes in the file) is answers-file.js; this is the DOM
 * and the timing. No markup strings: prompts and help go in as text.
 */

import { MAX_RADIO_CHOICES, QUESTION_STATUS, answeredCount, displayValue, fieldValue, mergeAnswers, parseAnswersFile, questionStatus, serializeAnswers } from './answers-file.js';
import { appendInline } from './markdown.js';
import { button, make } from './learn-ui.js';

export const SAVE_DELAY_MS = 600;

let uid = 0;

/**
 * Mounts the form in `host`.
 *   fields     the bundle's fields ({ key, prompt, kind, choices?, placeholder?, help? })
 *   file       the answers file's name, for the lede
 *   io         { read(): Promise<string | null>, write(text): Promise<void>, onWritten?(text) }
 *              read resolves null when the file does not exist and throws on any other failure
 *   runChecks  () => Promise<string | void>: the console's check action; a returned
 *              string is shown beside the button
 *   delay      debounce, in ms (default 600)
 *   onProgress ({ answered, total }) whenever the number of answered questions may have changed
 * Returns { reload, save, flush, disable, destroy, statusText, progress, setResults, focusFirstUnanswered }.
 *
 * Each question is a card with a badge (Not answered, Answered, Saved). A lab
 * whose checks report per question can pass them to setResults({ key: { pass } })
 * and the badges turn to Checked, correct or not yet.
 */
export function mountQuestionsForm(host, { fields, file, io, runChecks, delay = SAVE_DELAY_MS, onProgress }) {
  const form = make('form', 'qform');
  form.noValidate = true;
  form.addEventListener('submit', (e) => e.preventDefault());

  const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const head = make('div', 'qform-head');
  const heading = make('div', 'qform-heading');
  heading.append(make('span', 'eyebrow qform-eyebrow', 'Your answers'));
  const title = make('h2', 'qform-title');
  title.append(`${NUMBER_WORDS[fields.length] ?? fields.length} ${fields.length === 1 ? 'thing' : 'things'} to `, make('span', 'mark', 'find out.'));
  heading.append(title);
  const filled = make('span', 'qform-save');
  head.append(heading, filled);
  form.append(head);

  const lede = make('p', 'qform-lede');
  lede.append('Your answers are saved to ');
  lede.append(make('code', '', file));
  lede.append(' in the workspace as you type. The checks read that file.');
  form.append(lede);

  /** key -> { field, get(): raw string, set(string), inputs: HTMLElement[] } */
  const controls = new Map();
  const dirty = new Set();
  /** key -> { pass } from a check run that reports per question (see setResults). */
  let results = {};
  const edits = Object.create(null);
  let timer = 0;
  let saving = null;
  let again = false;
  let disabled = false;
  let destroyed = false;

  const status = make('span', 'qform-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const setStatus = (kind, detail = '') => {
    status.dataset.state = kind;
    status.textContent =
      kind === 'saved' ? 'Saved'
      : kind === 'saving' ? 'Saving…'
      : kind === 'pending' ? 'Unsaved changes'
      : kind === 'error' ? `Not saved. ${detail}`
      : kind === 'loaderror' ? `Could not load your answers. ${detail}`
      : kind === 'ended' ? 'This session has ended; answers can no longer be saved.'
      : '';
  };

  const changed = (key) => {
    dirty.add(key);
    refreshCards();
    edits[key] = (edits[key] || 0) + 1;
    setStatus('pending');
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      void save();
    }, delay);
  };

  // --- fields ---------------------------------------------------------------

  for (const [n, field] of fields.entries()) {
    const id = `qf${++uid}`;
    const wrap = make('div', 'qfield');
    wrap.dataset.key = field.key;
    const top = make('div', 'qfield-top');
    const badge = make('span', 'badge qfield-status');
    top.append(badge, make('span', 'qfield-index', `${n + 1} of ${fields.length}`));
    wrap.append(top);
    const helpId = field.help ? `${id}-help` : '';
    let control;

    if (field.kind === 'choice' && (field.choices || []).length <= MAX_RADIO_CHOICES) {
      const set = make('fieldset', 'qfield-set');
      const legend = make('legend', 'qfield-prompt');
      appendInline(legend, field.prompt);
      set.append(legend);
      const radios = [];
      const group = make('div', 'qfield-choices');
      for (const choice of field.choices) {
        const label = make('label', 'qfield-choice');
        const input = make('input');
        input.type = 'radio';
        input.name = id;
        input.value = choice;
        if (helpId) input.setAttribute('aria-describedby', helpId);
        input.addEventListener('change', () => changed(field.key));
        label.append(input, make('span', '', choice));
        group.append(label);
        radios.push(input);
      }
      set.append(group);
      wrap.append(set);
      control = {
        inputs: radios,
        get: () => radios.find((r) => r.checked)?.value ?? '',
        set: (v) => radios.forEach((r) => (r.checked = r.value === v)),
      };
    } else {
      const label = make('label', 'qfield-prompt');
      label.htmlFor = id;
      appendInline(label, field.prompt);
      wrap.append(label);
      let input;
      if (field.kind === 'choice') {
        input = make('select', 'qfield-input');
        const blank = make('option', '', 'Choose…');
        blank.value = '';
        input.append(blank);
        for (const choice of field.choices) {
          const o = make('option', '', choice);
          o.value = choice;
          input.append(o);
        }
      } else {
        input = make('input', 'qfield-input');
        input.type = field.kind === 'number' ? 'number' : 'text';
        if (field.kind === 'number') {
          input.step = 'any';
          input.inputMode = 'decimal';
        }
        input.autocomplete = 'off';
        if (field.placeholder) input.placeholder = field.placeholder;
      }
      input.id = id;
      if (helpId) input.setAttribute('aria-describedby', helpId);
      input.addEventListener(field.kind === 'choice' ? 'change' : 'input', () => changed(field.key));
      wrap.append(input);
      control = { inputs: [input], get: () => input.value, set: (v) => (input.value = v) };
    }

    if (field.help) {
      const help = make('p', 'qfield-help');
      help.id = helpId;
      appendInline(help, field.help);
      wrap.append(help);
    }
    controls.set(field.key, { field, badge, wrap, ...control });
    form.append(wrap);
  }

  // --- actions --------------------------------------------------------------

  const saveBtn = button('Save', { kind: 'ghost', onClick: () => void save(), id: 'btnSaveAnswers' });
  const checksBtn = button('Check my answers', {
    kind: 'accent',
    onClick: async () => {
      checksBtn.disabled = true;
      checksNote.textContent = '';
      try {
        await flush();
        if (status.dataset.state === 'error') return;
        const note = await runChecks?.();
        checksNote.textContent = typeof note === 'string' ? note : '';
      } finally {
        checksBtn.disabled = disabled;
      }
    },
    id: 'btnRunChecksForm',
  });
  const checksNote = make('span', 'qform-checks small muted');
  checksNote.setAttribute('role', 'status');
  checksNote.setAttribute('aria-live', 'polite');
  const actions = make('div', 'qform-actions');
  actions.append(checksBtn, saveBtn, status, checksNote);
  form.append(actions);
  host.replaceChildren(form);

  // --- data -----------------------------------------------------------------

  const currentValues = () => {
    const out = {};
    for (const [key, c] of controls) out[key] = fieldValue(c.field, c.get());
    return out;
  };

  /** Every card's badge and the count, from what the controls hold now. */
  let lastAnswered = -1;
  function refreshCards() {
    const values = currentValues();
    for (const [key, c] of controls) {
      const kind = questionStatus({ value: values[key], dirty: dirty.has(key), result: results[key] });
      const { text, tone } = QUESTION_STATUS[kind];
      c.wrap.dataset.status = kind;
      c.badge.textContent = text;
      c.badge.className = `badge qfield-status badge-${tone}`;
    }
    const answered = answeredCount(fields, values);
    filled.textContent = `${answered} of ${fields.length} filled in`;
    if (answered !== lastAnswered) {
      lastAnswered = answered;
      onProgress?.({ answered, total: fields.length });
    }
  }

  /** Shows `obj` in every control the learner has not touched. */
  const fill = (obj) => {
    for (const [key, c] of controls) {
      if (dirty.has(key)) continue;
      const text = displayValue(c.field, obj[key]);
      if (c.get() !== text) c.set(text);
    }
    refreshCards();
  };

  async function readFileObject() {
    const text = await io.read();
    return { text, obj: parseAnswersFile(text ?? '') };
  }

  /** Reads the file into the untouched controls. A missing or invalid file is empty. */
  async function reload() {
    if (saving || destroyed) return;
    try {
      const { obj } = await readFileObject();
      fill(obj);
      if (status.dataset.state === 'loaderror') setStatus('');
    } catch (err) {
      setStatus('loaderror', err?.message ?? '');
    }
  }

  /** Writes now: read the file again, merge by key, write the whole file. */
  function save() {
    clearTimeout(timer);
    timer = 0;
    if (destroyed || disabled) return Promise.resolve();
    if (saving) {
      again = true;
      return saving;
    }
    saving = (async () => {
      setStatus('saving');
      try {
        do {
          again = false;
          const seen = { ...edits };
          const { obj: disk } = await readFileObject();
          const merged = mergeAnswers(disk, fields, currentValues(), dirty);
          const text = serializeAnswers(merged);
          await io.write(text);
          for (const key of [...dirty]) if (edits[key] === seen[key]) dirty.delete(key);
          fill(merged);
          io.onWritten?.(text);
        } while (again);
        setStatus(dirty.size ? 'pending' : 'saved');
        refreshCards();
      } catch (err) {
        setStatus('error', `${err?.message ?? 'The write failed'}. Your answers are still here; press Save to try again.`);
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  /** Saves what is pending (and waits for a write in flight). */
  async function flush() {
    if (saving) await saving;
    if (dirty.size || timer) await save();
  }

  refreshCards();

  return {
    reload,
    save,
    flush,
    statusText: () => status.textContent,
    /** { answered, total } now. */
    progress: () => ({ answered: answeredCount(fields, currentValues()), total: fields.length }),
    /** Per-question outcomes of a check run, `{ key: { pass } }`; the badges follow. */
    setResults(next) {
      results = next && typeof next === 'object' ? next : {};
      refreshCards();
    },
    /** Puts the cursor on the first question without an answer (or the first question). */
    focusFirstUnanswered() {
      const values = currentValues();
      const pick = [...controls.values()].find((c) => values[c.field.key] == null) ?? [...controls.values()][0];
      pick?.inputs[0]?.focus();
    },
    disable() {
      disabled = true;
      clearTimeout(timer);
      for (const c of controls.values()) for (const i of c.inputs) i.disabled = true;
      saveBtn.disabled = true;
      checksBtn.disabled = true;
      setStatus('ended');
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      host.replaceChildren();
    },
  };
}
