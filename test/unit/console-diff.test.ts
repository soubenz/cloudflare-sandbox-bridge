import { describe, it, expect } from 'vitest';

/**
 * The line differ behind "Compare with my work". It is a browser module
 * with no DOM, so it is imported directly; the specifier is cast so the
 * TypeScript project (which does not compile JS) does not need a
 * declaration file for it.
 */
type Op = { type: 'same' | 'add' | 'del'; text: string; aLine?: number; bLine?: number };
type Gap = { type: 'gap'; count: number };
const { diffLines, collapseContext, splitLines } = (await import('../../dashboard/src/diff.js' as string)) as {
  diffLines: (a: string, b: string) => Op[];
  collapseContext: (ops: Array<Op | Gap>, context?: number) => Array<Op | Gap>;
  splitLines: (text: string) => string[];
};

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1));
const text = (ls: string[]) => ls.join('\n') + '\n';
const summary = (ops: Op[]) => ops.map((o) => `${o.type === 'same' ? ' ' : o.type === 'add' ? '+' : '-'}${o.text}`);

/** Replaying the ops must rebuild both inputs, with consistent line numbers. */
function replay(ops: Op[]) {
  const a: string[] = [];
  const b: string[] = [];
  for (const op of ops) {
    if (op.type !== 'add') {
      a.push(op.text);
      expect(op.aLine).toBe(a.length);
    } else expect(op.aLine).toBeUndefined();
    if (op.type !== 'del') {
      b.push(op.text);
      expect(op.bLine).toBe(b.length);
    } else expect(op.bLine).toBeUndefined();
  }
  return { a, b };
}

/** Length of the longest common subsequence, by the textbook table. */
function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j]!, row[j - 1]!);
      diag = up;
    }
  }
  return row[b.length]!;
}

describe('splitLines', () => {
  it('ignores one trailing newline and reads CRLF as LF', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('diffLines', () => {
  it('reports identical text as all unchanged, numbered on both sides', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(ops.map((o) => o.type)).toEqual(['same', 'same', 'same']);
    expect(ops.map((o) => [o.aLine, o.bLine])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('reports lines only in the second text as additions', () => {
    const ops = diffLines('a\nc\n', 'a\nb\nc\nd\n');
    expect(summary(ops)).toEqual([' a', '+b', ' c', '+d']);
    expect(ops[1]).toEqual({ type: 'add', text: 'b', bLine: 2 });
  });

  it('reports lines only in the first text as deletions', () => {
    const ops = diffLines('a\nb\nc\nd\n', 'a\nc\n');
    expect(summary(ops)).toEqual([' a', '-b', ' c', '-d']);
    expect(ops[1]).toEqual({ type: 'del', text: 'b', aLine: 2 });
  });

  it('puts deletions before additions in a replaced stretch', () => {
    const ops = diffLines('keep\nold 1\nold 2\nkeep too\n', 'keep\nnew\nkeep too\n');
    expect(summary(ops)).toEqual([' keep', '-old 1', '-old 2', '+new', ' keep too']);
    replay(ops);
  });

  it('handles an empty side', () => {
    expect(diffLines('', '')).toEqual([]);
    expect(summary(diffLines('', 'x\ny\n'))).toEqual(['+x', '+y']);
    expect(summary(diffLines('x\ny\n', ''))).toEqual(['-x', '-y']);
    expect(diffLines('', 'x\ny\n').map((o) => o.bLine)).toEqual([1, 2]);
  });

  it('treats CRLF and LF as the same text', () => {
    const ops = diffLines('a\r\nb\r\nc\r\n', 'a\nb\nc\n');
    expect(ops.every((o) => o.type === 'same')).toBe(true);
    expect(ops.every((o) => !o.text.includes('\r'))).toBe(true);
  });

  it('does not count a missing trailing newline as a difference', () => {
    expect(diffLines('a\nb', 'a\nb\n').every((o) => o.type === 'same')).toBe(true);
    expect(diffLines('a\nb\n', 'a\nb').every((o) => o.type === 'same')).toBe(true);
  });

  it('does show a blank line that is really there', () => {
    expect(summary(diffLines('a\n', 'a\n\n'))).toEqual([' a', '+']);
  });

  it('keeps repeated lines apart (duplicates are not merged)', () => {
    const ops = diffLines('x\nx\nx\n', 'x\nx\n');
    expect(ops.filter((o) => o.type === 'same')).toHaveLength(2);
    expect(ops.filter((o) => o.type === 'del')).toHaveLength(1);
  });

  it('finds a minimal script and rebuilds both inputs, on random text', () => {
    // A small alphabet makes repeats and reorderings common.
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: rand(14) }, () => String.fromCharCode(97 + rand(4)));
      const b = Array.from({ length: rand(14) }, () => String.fromCharCode(97 + rand(4)));
      const ops = diffLines(a.join('\n'), b.join('\n'));
      const rebuilt = replay(ops);
      // Blank entries never occur (letters only), so nothing is lost to normalising.
      expect(rebuilt.a).toEqual(a);
      expect(rebuilt.b).toEqual(b);
      expect(ops.filter((o) => o.type === 'same')).toHaveLength(lcs(a, b));
    }
  });

  it('does 2,000-line files with scattered edits in well under a second', () => {
    const a = lines(2000);
    const b = [...a];
    for (let i = 5; i < 2000; i += 37) b[i] = `${b[i]} edited`;
    b.splice(700, 0, 'inserted 1', 'inserted 2');
    b.splice(1500, 12);
    const started = performance.now();
    const ops = diffLines(text(a), text(b));
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(500);
    const rebuilt = replay(ops);
    expect(rebuilt.a).toEqual(a);
    expect(rebuilt.b).toEqual(b);
    expect(ops.filter((o) => o.type !== 'same').length).toBeGreaterThan(50);
  });

  it('does 2,000 lines that share nothing quickly, and still rebuilds both', () => {
    const a = lines(2000, (i) => `left ${i}`);
    const b = lines(2000, (i) => `right ${i}`);
    const started = performance.now();
    const ops = diffLines(text(a), text(b));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(ops.filter((o) => o.type === 'del')).toHaveLength(2000);
    expect(ops.filter((o) => o.type === 'add')).toHaveLength(2000);
    const rebuilt = replay(ops);
    expect(rebuilt.a).toEqual(a);
    expect(rebuilt.b).toEqual(b);
  });

  it('does 2,000 lines that are heavily rewritten but share some lines, quickly', () => {
    const a = lines(2000, (i) => (i % 3 === 0 ? '}' : `alpha ${i}`));
    const b = lines(2000, (i) => (i % 3 === 0 ? '}' : `beta ${i}`));
    const started = performance.now();
    const ops = diffLines(text(a), text(b));
    expect(performance.now() - started).toBeLessThan(1000);
    const rebuilt = replay(ops);
    expect(rebuilt.a).toEqual(a);
    expect(rebuilt.b).toEqual(b);
  });
});

describe('collapseContext', () => {
  const same = (n: number): Op[] => diffLines(text(lines(n)), text(lines(n)));
  const change = (before: number, between: number, after: number) => {
    // `between` unchanged lines separate the two changes; `before`/`after` lead and trail.
    const a = [...lines(before, (i) => `pre ${i}`), 'A1', ...lines(between, (i) => `mid ${i}`), 'A2', ...lines(after, (i) => `post ${i}`)];
    const b = [...lines(before, (i) => `pre ${i}`), 'B1', ...lines(between, (i) => `mid ${i}`), 'B2', ...lines(after, (i) => `post ${i}`)];
    return diffLines(text(a), text(b));
  };
  const shape = (ops: Array<Op | Gap>) => ops.map((o) => (o.type === 'gap' ? `gap${(o as Gap).count}` : o.type === 'same' ? 's' : o.type[0])).join(' ');

  it('folds a long unchanged file into one gap', () => {
    expect(collapseContext(same(10))).toEqual([{ type: 'gap', count: 10 }]);
    expect(collapseContext([])).toEqual([]);
  });

  it('keeps three lines of context beside a change and folds the rest', () => {
    const ops = change(10, 0, 10);
    const out = collapseContext(ops);
    expect(shape(out)).toBe('gap7 s s s d d a a s s s gap7');
  });

  it('folds the leading and trailing runs only on the side away from the change', () => {
    const out = collapseContext(change(5, 0, 2));
    // 5 leading: 2 hidden + 3 kept; 2 trailing: both kept, nothing to fold.
    expect(shape(out)).toBe('gap2 s s s d d a a s s');
  });

  it('does not fold a run between changes that fits within twice the context', () => {
    expect(shape(collapseContext(change(0, 6, 0)))).toBe('d a s s s s s s d a');
  });

  it('folds a run between changes at the first length that exceeds twice the context', () => {
    expect(shape(collapseContext(change(0, 7, 0)))).toBe('d a s s s gap1 s s s d a');
    expect(shape(collapseContext(change(0, 10, 0)))).toBe('d a s s s gap4 s s s d a');
  });

  it('honours other context sizes, including none', () => {
    expect(shape(collapseContext(change(4, 0, 4), 1))).toBe('gap3 s d d a a s gap3');
    expect(shape(collapseContext(change(2, 0, 2), 0))).toBe('gap2 d d a a gap2');
  });

  it('counts exactly the lines it hides', () => {
    const ops = change(40, 30, 40);
    const out = collapseContext(ops);
    const hidden = out.filter((o) => o.type === 'gap').reduce((n, o) => n + (o as Gap).count, 0);
    expect(out.filter((o) => o.type !== 'gap').length + hidden).toBe(ops.length);
  });

  it('leaves the ops it keeps untouched, line numbers included', () => {
    const ops = change(10, 0, 0);
    const out = collapseContext(ops);
    expect(out.filter((o) => o.type !== 'gap')).toEqual(ops.slice(7));
  });
});
