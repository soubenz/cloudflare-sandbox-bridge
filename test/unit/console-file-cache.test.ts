import { describe, it, expect } from 'vitest';

/**
 * The console's read-ahead of the tree's files (dashboard/src/file-cache.js): a batch read fills it, an open
 * is answered from it, a background read revalidates it, and nothing older ever replaces something newer.
 * Pure module; the two reads are stubs here, resolved by hand where the order matters.
 */
type Row = { path: string; size?: number; isDirectory?: boolean };
type Entry = { content: string; stale: boolean };
type BatchFile = { path: string; content?: string; encoding?: string; error?: { code: string; message: string } };
interface Cache {
  get(path: string): Entry | undefined;
  lookup(path: string): Promise<Entry | undefined>;
  prefetch(rows: Row[]): Promise<number>;
  revalidate(path: string): Promise<{ content: string; changed: boolean } | null>;
  set(path: string, content: string): void;
  drop(path: string): void;
  markStale(): void;
  clear(): void;
}
const M = (await import('../../dashboard/src/file-cache.js' as string)) as {
  PREFETCH_MAX_FILES: number;
  PREFETCH_MAX_BYTES: number;
  prefetchable: (row: Row) => boolean;
  createFileCache: (deps: {
    scope: () => string | null;
    readMany: (paths: string[]) => Promise<{ files: BatchFile[] }>;
    readOne: (path: string) => Promise<{ content: string; encoding?: string }>;
  }) => Cache;
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A cache over an in-memory workspace; `disk` is what both reads answer unless a test holds them back. */
function setup(disk: Record<string, string> = {}) {
  const files = new Map(Object.entries(disk));
  const batches: string[][] = [];
  const reads: string[] = [];
  let session: string | null = 's1';
  const batch = (paths: string[]) => ({
    files: paths.map((path): BatchFile => (files.has(path) ? { path, content: files.get(path)!, encoding: 'utf-8' } : { path, error: { code: 'not_found', message: 'gone' } })),
  });
  const deps = {
    scope: () => session,
    readMany: async (paths: string[]) => {
      batches.push(paths);
      return batch(paths);
    },
    readOne: async (path: string) => {
      reads.push(path);
      if (!files.has(path)) throw Object.assign(new Error('404: gone'), { status: 404 });
      return { content: files.get(path)!, encoding: 'utf-8' };
    },
  };
  const cache = M.createFileCache({ scope: () => deps.scope(), readMany: (p) => deps.readMany(p), readOne: (p) => deps.readOne(p) });
  return { cache, files, batches, reads, deps, batch, switchSession: (id: string | null) => (session = id) };
}

const rows = (...paths: string[]): Row[] => paths.map((path) => ({ path, size: 10 }));

describe('prefetchable', () => {
  it('takes small text files, not folders, big files or binaries', () => {
    expect(M.prefetchable({ path: 'app.py', size: 100 })).toBe(true);
    expect(M.prefetchable({ path: 'gateway/config.yaml', size: 0 })).toBe(true);
    expect(M.prefetchable({ path: 'gateway', isDirectory: true })).toBe(false);
    expect(M.prefetchable({ path: 'big.log', size: M.PREFETCH_MAX_BYTES + 1 })).toBe(false);
    for (const p of ['logo.png', 'data.sqlite', 'x.pyc', 'a.tar.gz', 'font.woff2']) expect(M.prefetchable({ path: p, size: 10 }), p).toBe(false);
  });
});

describe('createFileCache', () => {
  it('reads the tree ahead in one batch and answers an open from it (hit)', async () => {
    const { cache, batches, reads } = setup({ 'app.py': 'print(1)\n', 'notes.md': '# n\n' });
    expect(await cache.prefetch([...rows('app.py', 'notes.md'), { path: 'dir', isDirectory: true }, { path: 'huge.log', size: 10 ** 7 }])).toBe(2);
    expect(batches).toEqual([['app.py', 'notes.md']]);
    expect(cache.get('app.py')).toEqual({ content: 'print(1)\n', stale: false });
    expect(await cache.lookup('notes.md')).toEqual({ content: '# n\n', stale: false });
    expect(reads).toEqual([]);
  });

  it(`asks for at most ${30} files a batch, and never again for what it holds fresh`, async () => {
    const disk = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.txt`, `${i}`]));
    const { cache, batches } = setup(disk);
    const all = rows(...Object.keys(disk));
    await cache.prefetch(all);
    expect(batches[0]).toHaveLength(M.PREFETCH_MAX_FILES);
    await cache.prefetch(all);
    expect(batches[1]).toEqual(Object.keys(disk).slice(M.PREFETCH_MAX_FILES));
    expect(await cache.prefetch(all)).toBe(0);
    expect(batches).toHaveLength(2);
  });

  it('keeps no entry for an error, a binary answer, or a failed batch', async () => {
    const { cache, deps } = setup({ 'ok.txt': 'ok' });
    deps.readMany = async () => ({
      files: [
        { path: 'ok.txt', content: 'ok', encoding: 'utf-8' },
        { path: 'bin.dat', content: '//4A', encoding: 'base64' },
        { path: 'gone.txt', error: { code: 'not_found', message: 'gone' } },
      ],
    });
    await cache.prefetch(rows('ok.txt', 'bin.dat', 'gone.txt'));
    expect(cache.get('ok.txt')?.content).toBe('ok');
    expect(cache.get('bin.dat')).toBeUndefined();
    expect(cache.get('gone.txt')).toBeUndefined();

    deps.readMany = async () => {
      throw new Error('500: boom');
    };
    expect(await cache.prefetch(rows('other.txt'))).toBe(0);
    expect(await cache.lookup('other.txt')).toBeUndefined();
  });

  it('an open during the batch waits for it rather than reading the file again', async () => {
    const { cache, deps, batch } = setup({ 'app.py': 'v1' });
    const held = deferred<{ files: BatchFile[] }>();
    deps.readMany = () => held.promise;
    const prefetching = cache.prefetch(rows('app.py'));
    const opened = cache.lookup('app.py');
    expect(cache.get('app.py')).toBeUndefined();
    held.resolve(batch(['app.py']));
    expect(await opened).toEqual({ content: 'v1', stale: false });
    await prefetching;
  });

  describe('revalidate', () => {
    it('reports a change, stores it, and says so only once', async () => {
      const { cache, files } = setup({ 'app.py': 'v1' });
      await cache.prefetch(rows('app.py'));
      files.set('app.py', 'v2');
      expect(await cache.revalidate('app.py')).toEqual({ content: 'v2', changed: true });
      expect(cache.get('app.py')?.content).toBe('v2');
      expect(await cache.revalidate('app.py')).toEqual({ content: 'v2', changed: false });
    });

    it('a save that lands while the read is in flight wins: the older answer is thrown away', async () => {
      const { cache, deps } = setup({ 'app.py': 'v1' });
      await cache.prefetch(rows('app.py'));
      const held = deferred<{ content: string; encoding: string }>();
      deps.readOne = () => held.promise;
      const revalidating = cache.revalidate('app.py');
      cache.set('app.py', 'saved');
      held.resolve({ content: 'v1', encoding: 'utf-8' });
      expect(await revalidating).toBeNull();
      expect(cache.get('app.py')?.content).toBe('saved');
    });

    it('a failed read drops the entry (the next open reads afresh) and rejects', async () => {
      const { cache, files } = setup({ 'app.py': 'v1' });
      await cache.prefetch(rows('app.py'));
      files.delete('app.py');
      await expect(cache.revalidate('app.py')).rejects.toThrow(/404/);
      expect(cache.get('app.py')).toBeUndefined();
    });
  });

  describe('invalidation', () => {
    it('a save sets the entry to what was written; a batch that started before it cannot put the old text back', async () => {
      const { cache, deps, batch } = setup({ 'app.py': 'v1' });
      const held = deferred<{ files: BatchFile[] }>();
      deps.readMany = () => held.promise;
      const prefetching = cache.prefetch(rows('app.py'));
      cache.set('app.py', 'saved');
      held.resolve(batch(['app.py']));
      await prefetching;
      expect(cache.get('app.py')).toEqual({ content: 'saved', stale: false });
    });

    it('drop forgets a file (deleted)', async () => {
      const { cache } = setup({ 'app.py': 'v1' });
      await cache.prefetch(rows('app.py'));
      cache.drop('app.py');
      expect(await cache.lookup('app.py')).toBeUndefined();
    });

    it('terminal activity marks everything stale: still shown, and the next prefetch reads it again', async () => {
      const { cache, batches, files } = setup({ 'app.py': 'v1', 'b.py': 'b' });
      await cache.prefetch(rows('app.py', 'b.py'));
      cache.markStale();
      expect(cache.get('app.py')).toEqual({ content: 'v1', stale: true });
      files.set('app.py', 'v2');
      await cache.prefetch(rows('app.py', 'b.py'));
      expect(batches).toEqual([
        ['app.py', 'b.py'],
        ['app.py', 'b.py'],
      ]);
      expect(cache.get('app.py')).toEqual({ content: 'v2', stale: false });
    });

    it('a batch in flight when the terminal was used lands already stale', async () => {
      const { cache, deps, batch } = setup({ 'app.py': 'v1' });
      const held = deferred<{ files: BatchFile[] }>();
      deps.readMany = () => held.promise;
      const prefetching = cache.prefetch(rows('app.py'));
      cache.markStale();
      held.resolve(batch(['app.py']));
      await prefetching;
      expect(cache.get('app.py')).toEqual({ content: 'v1', stale: true });
    });

    it('clear forgets everything, and drops what a batch from before it brings back', async () => {
      const { cache, deps, batch } = setup({ 'app.py': 'v1', 'b.py': 'b' });
      await cache.prefetch(rows('b.py'));
      const held = deferred<{ files: BatchFile[] }>();
      deps.readMany = () => held.promise;
      const prefetching = cache.prefetch(rows('app.py'));
      cache.clear();
      held.resolve(batch(['app.py']));
      await prefetching;
      expect(cache.get('app.py')).toBeUndefined();
      expect(cache.get('b.py')).toBeUndefined();
    });

    it('another session starts from empty', async () => {
      const { cache, switchSession } = setup({ 'app.py': 'v1' });
      await cache.prefetch(rows('app.py'));
      switchSession('s2');
      expect(cache.get('app.py')).toBeUndefined();
    });
  });
});
