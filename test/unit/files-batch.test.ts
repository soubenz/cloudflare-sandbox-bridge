import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';
import type { SessionRuntime } from '../../src/session/state';
import { MAX_BATCH_FILES, MAX_BATCH_FILE_BYTES, parseBatchReadBody, readWorkspaceFiles, readWorkspaceFile } from '../../src/session/files';
import { OpTiming, serverTimingHeader } from '../../src/lib/timing';

/**
 * POST /sessions/:id/files/read: several files in one container call, each answered on its own. The route
 * itself (auth) is asserted in auth-matrix.test.ts; this is the body parsing and the script.
 */

type Step = { exit: number; stdout?: string; stderr?: string };

function setup(steps: Step[]) {
  const fake = new FakeBackend();
  steps.forEach((s, i) => {
    const proc = new FakeProcess(`p${i}`, 300 + i);
    proc.resolveNext('output', { exitCode: s.exit, stdout: s.stdout ?? '', stderr: s.stderr ?? '' });
    fake.resolveNext('exec', proc);
  });
  const rt = { backend: () => fake.asBackend() } as unknown as SessionRuntime;
  return { rt, fake, argvs: () => fake.callsTo('exec').map((a) => [...(a[0] as string[])]) };
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected rejection');
}

function parseError(text: string): Error {
  try {
    parseBatchReadBody(text);
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a parse error');
}

describe('parseBatchReadBody', () => {
  it('takes {"paths": [...]}', () => {
    expect(parseBatchReadBody('{"paths":["a.py","gateway/config.yaml"]}')).toEqual(['a.py', 'gateway/config.yaml']);
  });

  it.each([
    ['not JSON', 'nope'],
    ['no paths', '{}'],
    ['null', 'null'],
    ['an empty list', '{"paths":[]}'],
    ['a non-string', '{"paths":["a", 1]}'],
    ['an empty string', '{"paths":[""]}'],
  ])('refuses %s as 400 bad_batch', (_name, text) => {
    expect(parseError(text).name).toBe('ApiError:400:bad_batch');
  });

  it(`refuses more than ${MAX_BATCH_FILES} paths`, () => {
    const paths = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => `f${i}`);
    expect(parseBatchReadBody(JSON.stringify({ paths: paths.slice(0, MAX_BATCH_FILES) }))).toHaveLength(MAX_BATCH_FILES);
    const err = parseError(JSON.stringify({ paths }));
    expect(err.name).toBe('ApiError:400:bad_batch');
    expect(err.message).toContain(String(MAX_BATCH_FILES));
  });
});

describe('readWorkspaceFiles', () => {
  it('is ONE exec: the fence over every path as root, then one runuser as learner reading them all', async () => {
    const { rt, argvs } = setup([{ exit: 0, stdout: `O ${b64('a')}\nO ${b64('b')}\n` }]);
    await readWorkspaceFiles(rt, ['a.py', '/workspace/sub/b.py']);
    expect(argvs()).toHaveLength(1);
    const [op] = argvs();
    expect(op!.slice(0, 2)).toEqual(['sh', '-c']);
    expect(op!.slice(3)).toEqual(['_', '/workspace/a.py', '/workspace/sub/b.py']);
    const script = op![2]!;
    expect(script).toContain('realpath -m -- "$a"');
    expect(script).toContain('case "$p" in /workspace|/workspace/*)');
    // The fence runs before (and outside) the learner shell; exactly one runuser.
    expect(script.indexOf('realpath')).toBeLessThan(script.indexOf('/usr/sbin/runuser -u learner -- sh -c'));
    expect(script.split('runuser').length - 1).toBe(1);
    expect(script).toContain(`-gt ${MAX_BATCH_FILE_BYTES}`);
    expect(script).toContain('[ ! -f "$f" ]');
  });

  it('answers each path in order: utf-8 text, base64 for other bytes, and the per-path errors', async () => {
    const binary = btoa(String.fromCharCode(0xff, 0xfe, 0x00));
    const stdout = [`O ${b64('héllo\n')}`, `O ${binary}`, 'O ', 'N', 'E', 'L 999999', `O ${b64('x')} !`].join('\n') + '\n';
    const { rt } = setup([{ exit: 0, stdout }]);
    const out = await readWorkspaceFiles(rt, ['a.txt', 'blob', 'empty', 'gone.py', 'leak', 'big.log', 'raced']);
    expect(out).toEqual([
      { path: 'a.txt', content: 'héllo\n', encoding: 'utf-8' },
      { path: 'blob', content: binary, encoding: 'base64' },
      { path: 'empty', content: '', encoding: 'utf-8' },
      { path: 'gone.py', error: { code: 'not_found', message: 'No such file or directory: gone.py' } },
      { path: 'leak', error: { code: 'bad_path', message: 'path escapes /workspace' } },
      { path: 'big.log', error: { code: 'too_large', message: expect.stringContaining('999999 bytes') } },
      { path: 'raced', error: { code: 'bad_path', message: 'path escapes /workspace' } },
    ]);
  });

  it('a path workspacePath refuses never reaches the container, and the rest still read', async () => {
    const { rt, argvs } = setup([{ exit: 0, stdout: `O ${b64('ok')}\n` }]);
    const out = await readWorkspaceFiles(rt, ['../etc/passwd', 'ok.txt', '/etc/shadow']);
    expect(argvs()[0]!.slice(3)).toEqual(['_', '/workspace/ok.txt']);
    expect(out.map((e) => ('error' in e ? e.error.code : e.content))).toEqual(['bad_path', 'ok', 'bad_path']);
    expect(out.map((e) => e.path)).toEqual(['../etc/passwd', 'ok.txt', '/etc/shadow']);
  });

  it('no exec at all when every path is refused', async () => {
    const { rt, fake } = setup([]);
    const out = await readWorkspaceFiles(rt, ['../x', 'a/../../y']);
    expect(out.every((e) => 'error' in e && e.error.code === 'bad_path')).toBe(true);
    expect(fake.callsTo('exec')).toEqual([]);
  });

  it('re-checks the size on the bytes that came back (a file can grow after its stat)', async () => {
    const big = btoa('a'.repeat(MAX_BATCH_FILE_BYTES + 1));
    const { rt } = setup([{ exit: 0, stdout: `O ${big}\n` }]);
    const [entry] = await readWorkspaceFiles(rt, ['grew.log']);
    expect(entry).toMatchObject({ path: 'grew.log', error: { code: 'too_large' } });
  });

  it('a failed exec, or an answer that does not line up with the paths, is a 500', async () => {
    const failed = setup([{ exit: 1, stderr: 'runuser: boom' }]);
    expect((await rejection(readWorkspaceFiles(failed.rt, ['a']))).name).toBe('ApiError:500:internal_error');
    const short = setup([{ exit: 0, stdout: 'N\n' }]);
    expect((await rejection(readWorkspaceFiles(short.rt, ['a', 'b']))).name).toBe('ApiError:500:internal_error');
  });

  const linux = process.platform === 'linux';
  const roots: string[] = [];
  afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  it.skipIf(!linux)('the real script, run by sh against a scratch /workspace (runuser swapped for env)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opalix-batch-'));
    roots.push(root);
    const ws = join(root, 'workspace');
    mkdirSync(join(ws, 'dir'), { recursive: true });
    writeFileSync(join(ws, 'a.txt'), 'héllo\n');
    writeFileSync(join(ws, 'with space'), 'x y');
    writeFileSync(join(ws, 'empty'), '');
    writeFileSync(join(ws, 'bin'), Buffer.from([0xff, 0xfe, 0x00]));
    writeFileSync(join(ws, 'big'), Buffer.alloc(MAX_BATCH_FILE_BYTES + 1, 65));
    writeFileSync(join(root, 'secret'), 'root only');
    symlinkSync(join(root, 'secret'), join(ws, 'leak'));
    symlinkSync('/dev/zero', join(ws, 'zero'));

    const backend = {
      exec: async (argv: string[]) => {
        const script = argv[2]!.replaceAll('/workspace', ws).replace('/usr/sbin/runuser -u learner --', 'env');
        const args = argv.slice(4).map((p) => p.replace(/^\/workspace/, ws));
        let stdout = '';
        let exitCode = 0;
        try {
          stdout = execFileSync('sh', ['-c', script, '_', ...args], { encoding: 'utf8', maxBuffer: 1e8 });
        } catch (e) {
          exitCode = (e as { status: number }).status;
        }
        return { output: async () => ({ exitCode, stdout, stderr: '' }) };
      },
    };
    const rt = { backend: () => backend } as unknown as SessionRuntime;
    const out = await readWorkspaceFiles(rt, ['a.txt', 'with space', 'empty', 'bin', 'big', 'leak', 'zero', 'dir', 'missing']);
    expect(out.map((e) => ('error' in e ? e.error.code : [e.encoding, e.content]))).toEqual([
      ['utf-8', 'héllo\n'],
      ['utf-8', 'x y'],
      ['utf-8', ''],
      ['base64', btoa(String.fromCharCode(0xff, 0xfe, 0x00))],
      'too_large',
      'bad_path', // a symlink out of /workspace: the fence
      'bad_path', // a link to a device: not a regular file
      'bad_path', // a directory, as the single read answers it
      'not_found',
    ]);
  });
});

describe('Server-Timing', () => {
  it('times the container call in two phases', async () => {
    const { rt } = setup([{ exit: 0, stdout: b64('x') }]);
    const timing = new OpTiming();
    await readWorkspaceFile(rt, '/workspace/a', timing);
    const phases = timing.done();
    expect(Object.keys(phases)).toEqual(['exec', 'output', 'do']);
    expect(Object.values(phases).every((ms) => ms >= 0)).toBe(true);
  });

  it('formats phases as a header, with descriptions for the known ones', () => {
    expect(serverTimingHeader({ running: 2.4, exec: 210, output: 401.6, do: 615, total: 640 })).toBe(
      'running;dur=2;desc="session state read", exec;dur=210;desc="container: start the process", ' +
        'output;dur=402;desc="container: run it and collect its output", do;dur=615;desc="Session DO, in all", total;dur=640;desc="Worker, in all"'
    );
    // A name that is not a header token is dropped rather than breaking the header.
    expect(serverTimingHeader({ 'bad name': 1, other: 3 })).toBe('other;dur=3');
  });
});
