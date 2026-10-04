import { describe, it, expect, vi } from 'vitest';
const { isStaleChunkError, recoverFromStaleBuild } = (await import('../../dashboard/src/stale-build.js' as string)) as {
  isStaleChunkError: (err: unknown) => boolean;
  recoverFromStaleBuild: (o: {
    canReload: boolean;
    now?: number;
    reload?: () => void;
    storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  }) => boolean;
};

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('isStaleChunkError', () => {
  it('knows how each browser words a module file that is gone', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://x/dist/chunk-AB.js'))).toBe(true);
    expect(isStaleChunkError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError({ name: 'ChunkLoadError', message: 'Loading chunk 3 failed.' })).toBe(true);
  });
  it('does not mistake other failures for it', () => {
    expect(isStaleChunkError(new Error('No such file or directory: read'))).toBe(false);
    expect(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });
});

describe('recoverFromStaleBuild', () => {
  it('reloads once when it is safe', () => {
    const reload = vi.fn();
    expect(recoverFromStaleBuild({ canReload: true, now: 1_000_000, reload, storage: memory() })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('never reloads over unsaved work', () => {
    const reload = vi.fn();
    expect(recoverFromStaleBuild({ canReload: false, now: 1_000_000, reload, storage: memory() })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
  it('does not loop: a second failure within a minute asks instead, and a later one reloads again', () => {
    const reload = vi.fn();
    const storage = memory();
    expect(recoverFromStaleBuild({ canReload: true, now: 1_000_000, reload, storage })).toBe(true);
    expect(recoverFromStaleBuild({ canReload: true, now: 1_030_000, reload, storage })).toBe(false);
    expect(recoverFromStaleBuild({ canReload: true, now: 1_070_000, reload, storage })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it('does not reload when it cannot remember that it did', () => {
    const reload = vi.fn();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(recoverFromStaleBuild({ canReload: true, now: 1, reload, storage: broken })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
