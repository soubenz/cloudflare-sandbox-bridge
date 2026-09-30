/**
 * A small line differ for the "Compare with my work" view: pure functions,
 * no DOM, so the console can use them and the unit tests can import them.
 *
 * Text is compared line by line after two normalisations that a learner
 * should never be shown as differences: CRLF is read as LF (an editor on
 * another platform is not a wrong answer), and one trailing newline is
 * ignored (a file that ends with "\n" and one that does not compare equal).
 */

/** Lines of a text, with CRLF read as LF and no empty last "line" for a trailing newline. */
export function splitLines(text) {
  if (text == null || text === '') return [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const SAME = 0;
const DEL = 1;
const ADD = 2;

/**
 * Most numbers of trace entries (one per diagonal per step) Myers may keep
 * before giving up. About 32MB. A middle that needs more edits than this
 * has hardly anything in common, where "all of yours out, all of theirs in"
 * is what a minimal diff would say anyway.
 */
const MAX_TRACE_ENTRIES = 8_000_000;

/**
 * Myers' O(ND) shortest edit script over two arrays of small integers.
 * Returns a Uint8Array of SAME/DEL/ADD steps in order, or null if the
 * trace budget ran out.
 */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let stored = 0;

  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
    trace.push(v.slice(off - d, off + d + 1));
    stored += 2 * d + 1;
    if (stored > MAX_TRACE_ENTRIES) return null;
  }
  return null;
}

/** Walks the saved diagonals from the end back to the start and returns the script forwards. */
function backtrack(trace, a, b, dEnd) {
  const steps = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push(SAME);
      x--;
      y--;
    }
    steps.push(x === prevX ? ADD : DEL);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    steps.push(SAME);
    x--;
    y--;
  }
  return Uint8Array.from(steps.reverse());
}

/**
 * The line diff turning `a` into `b`: an array of
 * `{ type: 'same' | 'add' | 'del', text, aLine?, bLine? }`, line numbers
 * counting from 1. `del` lines are only in `a` (they carry `aLine`), `add`
 * lines only in `b` (`bLine`), `same` lines have both. Within a changed
 * stretch the deletions come before the additions, as in a unified diff.
 */
export function diffLines(a, b) {
  const A = splitLines(a);
  const B = splitLines(b);

  // What both ends share needs no searching, and is most of any real diff.
  let head = 0;
  const shortest = Math.min(A.length, B.length);
  while (head < shortest && A[head] === B[head]) head++;
  let tailA = A.length;
  let tailB = B.length;
  while (tailA > head && tailB > head && A[tailA - 1] === B[tailB - 1]) {
    tailA--;
    tailB--;
  }

  const midA = A.slice(head, tailA);
  const midB = B.slice(head, tailB);
  let script;
  if (!midA.length) script = new Uint8Array(midB.length).fill(ADD);
  else if (!midB.length) script = new Uint8Array(midA.length).fill(DEL);
  else {
    // Lines become small integers so the inner loop compares numbers.
    const ids = new Map();
    const id = (line) => {
      let n = ids.get(line);
      if (n === undefined) ids.set(line, (n = ids.size));
      return n;
    };
    script = myers(midA.map(id), midB.map(id));
    if (!script) {
      script = new Uint8Array(midA.length + midB.length);
      script.fill(DEL, 0, midA.length).fill(ADD, midA.length);
    }
  }

  const ops = [];
  let ai = 0;
  let bi = 0;
  for (; ai < head; ai++, bi++) ops.push({ type: 'same', text: A[ai], aLine: ai + 1, bLine: bi + 1 });

  let dels = [];
  let adds = [];
  const flush = () => {
    ops.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const step of script) {
    if (step === SAME) {
      flush();
      ops.push({ type: 'same', text: A[ai], aLine: ai + 1, bLine: bi + 1 });
      ai++;
      bi++;
    } else if (step === DEL) {
      dels.push({ type: 'del', text: A[ai], aLine: ai + 1 });
      ai++;
    } else {
      adds.push({ type: 'add', text: B[bi], bLine: bi + 1 });
      bi++;
    }
  }
  flush();
  for (; ai < A.length; ai++, bi++) ops.push({ type: 'same', text: A[ai], aLine: ai + 1, bLine: bi + 1 });
  return ops;
}

/**
 * Folds runs of unchanged lines down to `context` lines beside each change,
 * replacing what is hidden with `{ type: 'gap', count }`. A run between two
 * changes keeps `context` lines at each end, so it is only folded when it is
 * longer than twice that; at the start or end of the file only the side
 * next to a change is kept. A file with no changes at all is one gap.
 */
export function collapseContext(ops, context = 3) {
  const keep = Math.max(0, Math.floor(context));
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== 'same') {
      out.push(ops[i++]);
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].type === 'same') j++;
    const after = i === 0 ? 0 : keep; // lines that follow a change
    const before = j === ops.length ? 0 : keep; // lines that lead into one
    if (j - i > after + before) {
      out.push(...ops.slice(i, i + after), { type: 'gap', count: j - i - after - before }, ...ops.slice(j - before, j));
    } else {
      out.push(...ops.slice(i, j));
    }
    i = j;
  }
  return out;
}
