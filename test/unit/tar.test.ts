import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { parseTar, gunzip, safeTarPath, TarError } from '../../src/lib/tar';
import { selectSolutionFiles, readSolutionFiles, SOLUTION_LIMITS } from '../../src/session/solution';
import { makeTar, makeTgz, streamOf } from './tar-writer';

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const byPath = (files: { path: string }[]) => files.map((f) => f.path);

describe('parseTar', () => {
  it('reads regular files and skips directories and symlinks', () => {
    const { files, truncated } = parseTar(
      makeTar([
        { name: './', type: '5' },
        { name: './app/', type: '5' },
        { name: './app/main.py', content: 'print("hi")\n' },
        { name: './notes.md', content: '# notes' },
        { name: './link', type: '2' },
        { name: './empty.txt' },
      ])
    );
    expect(truncated).toBe(false);
    expect(files.map((f) => [f.path, text(f.content)])).toEqual([
      ['app/main.py', 'print("hi")\n'],
      ['notes.md', '# notes'],
      ['empty.txt', ''],
    ]);
  });

  it('strips a leading ./ and accepts names without one', () => {
    const { files } = parseTar(makeTar([{ name: 'a.txt', content: 'a' }, { name: './b/c.txt', content: 'c' }]));
    expect(byPath(files)).toEqual(['a.txt', 'b/c.txt']);
  });

  it('a later entry of the same name replaces the earlier one', () => {
    const { files } = parseTar(makeTar([{ name: 'a.txt', content: 'old' }, { name: 'a.txt', content: 'new' }]));
    expect(files.map((f) => text(f.content))).toEqual(['new']);
  });

  it.each([
    ['a ".." segment', '../evil.txt'],
    ['a nested ".." segment', 'ok/../../evil.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'a\\b.txt'],
  ])('rejects %s', (_label, name) => {
    expect(() => parseTar(makeTar([{ name, content: 'x' }]))).toThrowError(TarError);
    try {
      parseTar(makeTar([{ name, content: 'x' }]));
    } catch (err) {
      expect((err as TarError).code).toBe('unsafe_path');
    }
  });

  it('rejects an unsafe path even when it arrives through a long-name entry', () => {
    const name = '../' + 'd/'.repeat(60) + 'evil.txt';
    expect(() => parseTar(makeTar([{ name, content: 'x' }], 'gnu-L'))).toThrowError(/\.\./);
    expect(() => parseTar(makeTar([{ name, content: 'x' }], 'pax'))).toThrowError(/\.\./);
  });

  it('refuses a corrupt header', () => {
    const tar = makeTar([{ name: 'a.txt', content: 'a' }]);
    tar[0] = tar[0]! ^ 0xff;
    expect(() => parseTar(tar)).toThrowError(expect.objectContaining({ code: 'bad_checksum' }));
  });

  it('refuses an entry that runs past the end, unless truncation is tolerated', () => {
    const tar = makeTar([{ name: 'a.txt', content: 'x'.repeat(2000) }, { name: 'b.txt', content: 'b' }]).subarray(0, 512 + 1024);
    expect(() => parseTar(tar)).toThrowError(expect.objectContaining({ code: 'truncated' }));
    expect(parseTar(tar, { tolerateTruncation: true })).toEqual({ files: [], truncated: true });
  });

  describe.each(['gnu-L', 'pax', 'ustar-prefix'] as const)('a name over 100 bytes (%s)', (style) => {
    it('comes back whole', () => {
      const name = `${'deeply/'.repeat(20)}nested/file.txt`;
      expect(name.length).toBeGreaterThan(100);
      const { files } = parseTar(makeTar([{ name, content: 'body' }, { name: 'short.txt', content: 's' }], style));
      expect(files.map((f) => [f.path, text(f.content)])).toEqual([[name, 'body'], ['short.txt', 's']]);
    });
  });
});

describe('what the CLI writer produces', () => {
  /** Runs the system tar, the one `labs publish` shells out to, over a real directory. */
  it.each([
    ['default', []],
    ['gnu', ['--format=gnu']],
    ['pax', ['--format=pax']],
  ])('gunzips and parses the system tar output (%s)', async (_label, flags) => {
    const dir = mkdtempSync(join(tmpdir(), 'opalix-tar-'));
    try {
      const longSegments = Array.from({ length: 12 }, (_, i) => `a-long-directory-name-${i}`);
      mkdirSync(join(dir, 'app/sub'), { recursive: true });
      mkdirSync(join(dir, ...longSegments), { recursive: true });
      writeFileSync(join(dir, 'app/main.py'), 'print(1)\n');
      writeFileSync(join(dir, 'app/sub/util.py'), 'x = 1\n');
      writeFileSync(join(dir, 'README.md'), 'read me');
      writeFileSync(join(dir, ...longSegments, 'deep.txt'), 'deep');

      const tgz = execFileSync('tar', ['czf', '-', ...flags, '-C', dir, '.']);
      const { bytes, truncated } = await gunzip(streamOf(tgz, 300), 1 << 20);
      expect(truncated).toBe(false);
      const { files } = parseTar(bytes);
      expect(byPath(files).sort()).toEqual(['README.md', 'app/main.py', 'app/sub/util.py', `${longSegments.join('/')}/deep.txt`].sort());
      expect(text(files.find((f) => f.path === 'app/main.py')!.content)).toBe('print(1)\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gunzip', () => {
  it('round-trips through a chunked stream', async () => {
    const payload = new TextEncoder().encode('hello '.repeat(5000));
    const { bytes, truncated } = await gunzip(streamOf(gzipSync(payload), 7), 1 << 20);
    expect(truncated).toBe(false);
    expect(bytes).toEqual(payload);
  });

  it('stops at the output cap instead of inflating a bomb', async () => {
    const bomb = gzipSync(new Uint8Array(4 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(10_000);
    const { bytes, truncated } = await gunzip(streamOf(bomb), 100_000);
    expect(truncated).toBe(true);
    expect(bytes.length).toBe(100_000);
  });

  it('rejects data that is not gzip', async () => {
    await expect(gunzip(streamOf(new TextEncoder().encode('not gzip at all')), 1000)).rejects.toThrow();
  });
});

describe('safeTarPath', () => {
  it('keeps dots inside names and drops empty and "." segments', () => {
    expect(safeTarPath('./a//b/./c.d.py')).toBe('a/b/c.d.py');
    expect(safeTarPath('..foo/bar')).toBe('..foo/bar');
    expect(safeTarPath('./')).toBeNull();
  });
});

describe('selectSolutionFiles caps', () => {
  const entry = (path: string, content: string | Uint8Array) => ({
    path,
    content: typeof content === 'string' ? new TextEncoder().encode(content) : content,
  });

  it('sorts by path and is not truncated when nothing was dropped', () => {
    const r = selectSolutionFiles([entry('b.txt', 'b'), entry('a/z.txt', 'z'), entry('a.txt', 'a')]);
    expect(r).toEqual({
      files: [{ path: 'a.txt', content: 'a' }, { path: 'a/z.txt', content: 'z' }, { path: 'b.txt', content: 'b' }],
      truncated: false,
    });
  });

  it('skips files that are not text without calling that truncation', () => {
    const r = selectSolutionFiles([
      entry('bad-utf8.txt', new Uint8Array([0x66, 0x6f, 0xff, 0xfe])),
      entry('has-nul.txt', new Uint8Array([0x61, 0x00, 0x62])),
      entry('image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])),
      entry('ok.txt', 'fine — with a dash'),
    ]);
    expect(r.files).toEqual([{ path: 'ok.txt', content: 'fine — with a dash' }]);
    expect(r.truncated).toBe(false);
  });

  it('drops a file over 64 KB and says so; exactly 64 KB is kept', () => {
    const r = selectSolutionFiles([
      entry('exact.txt', 'x'.repeat(SOLUTION_LIMITS.maxFileBytes)),
      entry('huge.txt', 'x'.repeat(SOLUTION_LIMITS.maxFileBytes + 1)),
    ]);
    expect(byPath(r.files)).toEqual(['exact.txt']);
    expect(r.truncated).toBe(true);
  });

  it('keeps 40 files and drops the rest', () => {
    const forty = Array.from({ length: 40 }, (_, i) => entry(`f${String(i).padStart(2, '0')}.txt`, 'x'));
    expect(selectSolutionFiles(forty)).toMatchObject({ truncated: false });
    expect(selectSolutionFiles(forty).files).toHaveLength(40);

    const r = selectSolutionFiles([...forty, entry('f40.txt', 'x')]);
    expect(r.files).toHaveLength(40);
    expect(r.files.at(-1)!.path).toBe('f39.txt');
    expect(r.truncated).toBe(true);
  });

  it('stops adding at 512 KB in total, in path order, but still takes a later file that fits', () => {
    const kb = (n: number) => 'x'.repeat(n * 1024);
    const entries = Array.from({ length: 9 }, (_, i) => entry(`big${i}.txt`, kb(60))); // 540 KB
    entries.push(entry('small.txt', 'tiny'));
    const r = selectSolutionFiles(entries);
    expect(byPath(r.files)).toEqual(['big0.txt', 'big1.txt', 'big2.txt', 'big3.txt', 'big4.txt', 'big5.txt', 'big6.txt', 'big7.txt', 'small.txt']);
    expect(r.truncated).toBe(true);
    expect(r.files.reduce((n, f) => n + f.content.length, 0)).toBeLessThanOrEqual(SOLUTION_LIMITS.maxTotalBytes);
  });
});

describe('readSolutionFiles (gzip in, files out)', () => {
  it('round-trips a tarball the way the route reads it', async () => {
    const tgz = makeTgz([
      { name: './app/main.py', content: 'print("solved")\n' },
      { name: './config.yaml', content: 'ok: true\n' },
      { name: './logo.png', content: new Uint8Array([0, 1, 2, 3]) },
    ]);
    expect(await readSolutionFiles(streamOf(tgz, 97))).toEqual({
      files: [
        { path: 'app/main.py', content: 'print("solved")\n' },
        { path: 'config.yaml', content: 'ok: true\n' },
      ],
      truncated: false,
    });
  });

  it('reports truncated when the archive is larger than the unpack cap', async () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.txt`, content: 'y'.repeat(60 * 1024) }));
    const r = await readSolutionFiles(streamOf(makeTgz(entries)));
    expect(r.truncated).toBe(false); // well under the cap: control
    const huge = makeTgz([{ name: 'a.txt', content: 'a' }, { name: 'zeros.bin', content: new Uint8Array(SOLUTION_LIMITS.maxUnpackedBytes + 1024 * 1024) }]);
    const cut = await readSolutionFiles(streamOf(huge));
    expect(cut.files).toEqual([{ path: 'a.txt', content: 'a' }]);
    expect(cut.truncated).toBe(true);
  });

  it('a traversal path makes the archive unreadable', async () => {
    await expect(readSolutionFiles(streamOf(makeTgz([{ name: '../x', content: 'x' }])))).rejects.toBeInstanceOf(TarError);
  });
});
