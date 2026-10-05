import { describe, expect, it } from 'vitest';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';
import type { SessionRuntime } from '../../src/session/state';
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  listWorkspaceDir,
  deleteWorkspaceFile,
} from '../../src/session/files';

/**
 * Card B-09: the files API must not follow a learner-planted symlink as
 * root. Every operation is one container call: a realpath fence, then the
 * operation itself as `learner`.
 */

/** Indexed access is unchecked-safe here: every test queues (and so asserts) the steps it reads. */
type Argvs = [string[], string[], string[], string[]];
type Step = { exit: number; stdout?: string; stderr?: string };

function setup(steps: Step[]): { rt: SessionRuntime; fake: FakeBackend; argvs: () => Argvs } {
  const fake = new FakeBackend();
  steps.forEach((s, i) => {
    const proc = new FakeProcess(`p${i}`, 300 + i);
    proc.resolveNext('output', { exitCode: s.exit, stdout: s.stdout ?? '', stderr: s.stderr ?? '' });
    fake.resolveNext('exec', proc);
  });
  const rt = { backend: () => fake.asBackend() } as unknown as SessionRuntime;
  return { rt, fake, argvs: () => fake.callsTo('exec').map((a) => [...(a[0] as string[])]) as Argvs };
}

const OK: Step = { exit: 0 };
const ESCAPES: Step = { exit: 97 };
const LEARNER = ['/usr/sbin/runuser', '-u', 'learner', '--'];
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected rejection');
}

describe('realpath fence', () => {
  it.each([
    ['read', (rt: SessionRuntime) => readWorkspaceFile(rt, '/workspace/leak')],
    ['list', (rt: SessionRuntime) => listWorkspaceDir(rt, '/workspace/leak')],
    ['delete', (rt: SessionRuntime) => deleteWorkspaceFile(rt, '/workspace/leak')],
  ])('%s: the fence exit is bad_path, and it is the only container call', async (_name, op) => {
    const { rt, argvs } = setup([ESCAPES]);
    const err = await rejection(op(rt));
    expect(err.name).toBe('ApiError:400:bad_path');
    expect(err.message).toMatch(/escapes \/workspace/);
    expect(argvs()).toHaveLength(1);
    expect(argvs()[0].slice(0, 2)).toEqual(['sh', '-c']);
    expect(argvs()[0][2]).toContain('realpath -m -- "$1"');
    expect(argvs()[0][2]).toContain('exit 97');
    expect(argvs()[0].slice(3)).toEqual(['_', '/workspace/leak']);
  });

  it('write: the fence rides in the write script, so an escape writes nothing outside the stage and cleans it up', async () => {
    const { rt, fake, argvs } = setup([OK, ESCAPES, OK]);
    const err = await rejection(writeWorkspaceFile(rt, '/workspace/leak', 'x'));
    expect(err.name).toBe('ApiError:400:bad_path');
    const [, write, rm] = argvs();
    expect(write[2]).toContain('realpath -m -- "$1"');
    const [[staged]] = fake.callsTo('writeFile') as [[string]];
    expect(rm).toEqual(['rm', '-f', staged]);
  });

  it('any other non-zero exit is a 500 carrying stderr', async () => {
    const { rt } = setup([{ exit: 1, stderr: 'realpath: boom' }]);
    const err = await rejection(readWorkspaceFile(rt, '/workspace/a'));
    expect(err.name).toBe('ApiError:500:internal_error');
    expect(err.message).toContain('realpath: boom');
  });
});

describe('readWorkspaceFile', () => {
  it('fences and reads as learner in one call, and decodes utf-8', async () => {
    const { rt, argvs } = setup([{ exit: 0, stdout: b64('héllo\n') }]);
    expect(await readWorkspaceFile(rt, '/workspace/notes.txt')).toEqual({ content: 'héllo\n', encoding: 'utf-8' });
    expect(argvs()).toHaveLength(1);
    const [op] = argvs();
    expect(op.slice(0, 2)).toEqual(['sh', '-c']);
    expect(op[2]).toContain('realpath -m -- "$1"');
    expect(op[2]).toContain(`exec ${LEARNER.join(' ')} sh -c 'base64 -w0 -- "$1"' _ "$1"`);
    expect(op.slice(3)).toEqual(['_', '/workspace/notes.txt']);
  });

  it('returns non-utf-8 bytes as base64', async () => {
    const raw = btoa(String.fromCharCode(0xff, 0xfe, 0x00));
    const { rt } = setup([{ exit: 0, stdout: raw }]);
    expect(await readWorkspaceFile(rt, '/workspace/blob')).toEqual({ content: raw, encoding: 'base64' });
  });

  it('maps a missing file to 404 not_found', async () => {
    const { rt } = setup([{ exit: 1, stderr: 'base64: /workspace/nope: No such file or directory' }]);
    expect((await rejection(readWorkspaceFile(rt, '/workspace/nope'))).name).toBe('ApiError:404:not_found');
  });

  it('maps permission denied to bad_path, same answer as the fence', async () => {
    const { rt } = setup([{ exit: 1, stderr: 'base64: /workspace/x: Permission denied' }]);
    const err = await rejection(readWorkspaceFile(rt, '/workspace/x'));
    expect(err.name).toBe('ApiError:400:bad_path');
    expect(err.message).toMatch(/escapes \/workspace/);
  });
});

describe('listWorkspaceDir', () => {
  it('fences and lists as learner in one call, and parses into the SDK shape sorted by name', async () => {
    const stdout = ['f\t12\t1700000000.5\tb.txt', 'd\t4096\t1700000100.0\ta dir', 'l\t9\t1700000200.0\tlink', 'f\t1\t0.0\ttab\tname'].join('\0') + '\0';
    const { rt, argvs } = setup([{ exit: 0, stdout }]);
    const result = await listWorkspaceDir(rt, '/workspace/sub');
    const [op] = argvs();
    expect(op.slice(0, 2)).toEqual(['sh', '-c']);
    expect(op[2]).toContain(`exec ${LEARNER.join(' ')} sh -c 'cd -- "$1" && find . -mindepth 1 -maxdepth 1 -printf`);
    expect(op.slice(3)).toEqual(['_', '/workspace/sub']);
    expect(result.count).toBe(4);
    expect(result.files.map((f) => f.name)).toEqual(['a dir', 'b.txt', 'link', 'tab\tname']);
    expect(result.files[0]).toEqual({
      name: 'a dir',
      absolutePath: '/workspace/sub/a dir',
      relativePath: 'a dir',
      type: 'directory',
      size: 4096,
      modifiedAt: new Date(1700000100 * 1000).toISOString(),
    });
    expect(result.files.map((f) => f.type)).toEqual(['directory', 'file', 'symlink', 'file']);
  });

  it('an empty directory lists empty', async () => {
    const { rt } = setup([OK]);
    expect(await listWorkspaceDir(rt, '/workspace')).toEqual({ files: [], count: 0 });
  });

  it('permission denied is bad_path', async () => {
    const { rt } = setup([{ exit: 1, stderr: 'sh: 1: cd: can\'t cd to /workspace/d/etc: Permission denied' }]);
    expect((await rejection(listWorkspaceDir(rt, '/workspace/d/etc'))).name).toBe('ApiError:400:bad_path');
  });
});

describe('writeWorkspaceFile', () => {
  it('stages under /run/opalix/stage, fences and writes as learner, then removes the stage file', async () => {
    const { rt, fake, argvs } = setup([OK, OK, OK]);
    await writeWorkspaceFile(rt, '/workspace/notes.txt', 'hello');

    const [stageDir, write, rm] = argvs();
    expect(stageDir[2]).toContain('mkdir -p /run/opalix/stage');

    const [[staged, content]] = fake.callsTo('writeFile') as [[string, string]];
    expect(staged).toMatch(/^\/run\/opalix\/stage\/write-[0-9a-f-]{36}$/);
    expect(content).toBe('hello');

    expect(write.slice(0, 2)).toEqual(['sh', '-c']);
    expect(write[2]).toContain('realpath -m -- "$1"');
    expect(write[2]).toContain('/usr/sbin/runuser -u learner -- sh -c');
    expect(write[2]).toContain('cat > "$1"');
    expect(write[2]).toContain('< "$2"');
    expect(write.slice(3)).toEqual(['_', '/workspace/notes.txt', staged]);
    expect(rm).toEqual(['rm', '-f', staged]);
  });

  it('removes the staged file even when the learner write fails', async () => {
    const { rt, fake, argvs } = setup([OK, { exit: 1, stderr: 'sh: 1: cannot create /workspace/d/etc/x: Permission denied' }, OK]);
    const err = await rejection(writeWorkspaceFile(rt, '/workspace/d/etc/x', 'hello'));
    expect(err.name).toBe('ApiError:400:bad_path');
    const [[staged]] = fake.callsTo('writeFile') as [[string]];
    expect(argvs().at(-1)).toEqual(['rm', '-f', staged]);
  });

  it('a non-permission failure is a 500 with stderr, and still cleans up', async () => {
    const { rt, argvs } = setup([OK, { exit: 2, stderr: 'weird' }, OK]);
    const err = await rejection(writeWorkspaceFile(rt, '/workspace/a', 'x'));
    expect(err.name).toBe('ApiError:500:internal_error');
    expect(err.message).toContain('weird');
    expect(argvs().at(-1)?.[0]).toBe('rm');
  });

  it('413s an oversize body before touching the container', async () => {
    const { rt, fake } = setup([]);
    const err = await rejection(writeWorkspaceFile(rt, '/workspace/big', 'x'.repeat(2 * 1024 * 1024 + 1)));
    expect(err.name).toBe('ApiError:413:payload_too_large');
    expect(fake.callsTo('exec')).toEqual([]);
  });

  it('counts bytes, not characters', async () => {
    const { rt } = setup([]);
    const err = await rejection(writeWorkspaceFile(rt, '/workspace/big', 'é'.repeat(1024 * 1024 + 1)));
    expect(err.name).toBe('ApiError:413:payload_too_large');
  });
});

describe('deleteWorkspaceFile', () => {
  it('fences and runs rm -f as learner in one call', async () => {
    const { rt, argvs } = setup([OK]);
    await deleteWorkspaceFile(rt, '/workspace/scratch.txt');
    expect(argvs()).toHaveLength(1);
    expect(argvs()[0][2]).toContain(`exec ${LEARNER.join(' ')} sh -c 'rm -f -- "$1"' _ "$1"`);
    expect(argvs()[0].slice(3)).toEqual(['_', '/workspace/scratch.txt']);
  });

  it('permission denied is bad_path', async () => {
    const { rt } = setup([{ exit: 1, stderr: 'rm: cannot remove: Permission denied' }]);
    expect((await rejection(deleteWorkspaceFile(rt, '/workspace/x'))).name).toBe('ApiError:400:bad_path');
  });
});
