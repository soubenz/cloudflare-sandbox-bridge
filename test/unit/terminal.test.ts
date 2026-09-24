import { describe, it, expect, beforeAll } from 'vitest';
import { createFakeRuntime } from '../fakes/fake-runtime';
import { ensureUpstreamConnected } from '../../src/session/terminal';
import type { SessionRuntime, TerminalRuntime } from '../../src/session/state';

/**
 * The terminal relay's re-attach decision, exercised against a fake
 * backend.
 *
 * The bug these cover: a session stores one terminal id, and every later
 * attach used to reuse it on the strength of `getTerminal()` returning
 * non-null. The container's terminal registry keeps a terminal after its
 * process is gone (that is what `TerminalSnapshot.status` is for), and a
 * dead one still accepts `connect()` and `resize()` — it just never emits
 * a byte and never closes. So the reused upstream stayed OPEN forever,
 * swallowing every keystroke, and neither `terminal_upstream_closed` nor
 * the reconnect in `handleClientMessage` ever fired: the learner's panel
 * went dead in silence for the rest of the session.
 *
 * Plain Node, no Miniflare (see vitest.config.ts), so the two Workers
 * globals the relay touches are stubbed below.
 */

interface FakeTerminal {
  id: string;
  status: 'running' | 'exited' | 'error';
  snapshotThrows?: boolean;
  connectedWith?: { cursor?: string };
}

function fakeTerminal(t: FakeTerminal) {
  return {
    id: t.id,
    getSnapshot: async () => {
      if (t.snapshotThrows) throw new Error('Terminal not found: ' + t.id);
      return { id: t.id, command: ['sh'], status: t.status };
    },
    connect: async (_req: Request, options?: { cursor?: string }) => {
      t.connectedWith = { cursor: options?.cursor };
      return { webSocket: fakeUpstreamSocket() };
    },
    resize: async () => {},
  };
}

function fakeUpstreamSocket() {
  return {
    readyState: 1,
    binaryType: 'blob',
    accept() {},
    addEventListener() {},
    send() {},
    close() {},
  };
}

/** A backend with exactly the two terminal calls the relay makes. */
function fakeBackend(existing: FakeTerminal | null) {
  const created: Array<{ command: string[]; cwd?: string; cols?: number; rows?: number }> = [];
  const terminals = new Map<string, FakeTerminal>();
  if (existing) terminals.set(existing.id, existing);
  let nextId = 1;

  return {
    created,
    terminals,
    getTerminalCalls: [] as string[],
    async getTerminal(id: string) {
      this.getTerminalCalls.push(id);
      const t = terminals.get(id);
      return t ? fakeTerminal(t) : null;
    },
    async createTerminal(options: { command: string[]; cwd?: string; cols?: number; rows?: number }) {
      created.push(options);
      const t: FakeTerminal = { id: `fresh-${nextId++}`, status: 'running' };
      terminals.set(t.id, t);
      return fakeTerminal(t);
    },
  };
}

async function attach(stored: TerminalRuntime | undefined, existing: FakeTerminal | null) {
  const { rt } = createFakeRuntime();
  const backend = fakeBackend(existing);
  // bindBackend() dynamically imports the real @cloudflare/sandbox backend,
  // which cannot load outside the Workers runtime; inject the fake instead.
  (rt as unknown as { _backend: unknown })._backend = backend;
  if (stored) await rt.putTerminal(stored);

  await ensureUpstreamConnected(rt as SessionRuntime, new Request('http://do/x'));
  return { rt, backend };
}

const STORED: TerminalRuntime = {
  id: 'term-old',
  argv: ['su', '-l', 'learner'],
  cwd: '/workspace',
  cols: 100,
  rows: 40,
  cursor: 'cursor-42',
};

beforeAll(() => {
  // The relay compares against WebSocket.READY_STATE_OPEN, a Workers-only
  // static, and Node's own WebSocket does not carry it.
  const g = globalThis as unknown as { WebSocket: { READY_STATE_OPEN: number } };
  g.WebSocket = { ...(g.WebSocket ?? {}), READY_STATE_OPEN: 1 };
});

describe('re-attaching to a stored terminal', () => {
  it('reuses the stored terminal while its PTY is still running', async () => {
    const { rt, backend } = await attach(STORED, { id: 'term-old', status: 'running' });

    expect(backend.created).toHaveLength(0);
    // Same terminal, so the stored ref (cursor included) is left alone.
    expect(await rt.terminal()).toEqual(STORED);
    // ...and the output stream resumes where it left off.
    expect(backend.terminals.get('term-old')!.connectedWith).toEqual({ cursor: 'cursor-42' });
  });

  it('creates a fresh terminal when the stored one has exited', async () => {
    const { rt, backend } = await attach(STORED, { id: 'term-old', status: 'exited' });

    expect(backend.created).toHaveLength(1);
    const ref = await rt.terminal();
    expect(ref!.id).not.toBe('term-old');
    // The dead terminal must not be the one the client is wired to.
    expect(backend.terminals.get('term-old')!.connectedWith).toBeUndefined();
  });

  it('creates a fresh terminal when the stored one is in error', async () => {
    const { backend } = await attach(STORED, { id: 'term-old', status: 'error' });
    expect(backend.created).toHaveLength(1);
  });

  it('creates a fresh terminal when the terminal id is gone from the container', async () => {
    const { rt, backend } = await attach(STORED, null);
    expect(backend.created).toHaveLength(1);
    expect((await rt.terminal())!.id).not.toBe('term-old');
  });

  it('fails closed: an unreadable snapshot means a fresh terminal, not an assumed-healthy one', async () => {
    const { backend } = await attach(STORED, { id: 'term-old', status: 'running', snapshotThrows: true });
    expect(backend.created).toHaveLength(1);
  });

  it('does not replay the dead terminal\'s cursor onto the fresh one', async () => {
    const { rt, backend } = await attach(STORED, { id: 'term-old', status: 'exited' });

    const fresh = backend.terminals.get((await rt.terminal())!.id)!;
    expect(fresh.connectedWith).toEqual({ cursor: undefined });
    // The stale cursor is dropped from storage too, so a later attach
    // cannot resurrect it.
    expect((await rt.terminal())!.cursor).toBeUndefined();
  });

  it('relaunches through tmux so the replacement PTY resumes the learner\'s shell', async () => {
    // Replacing a dead terminal is only safe because the shell lives in a
    // named tmux session: `new-session -A` re-attaches to it rather than
    // starting a second shell, keeping cwd, environment and scrollback. If
    // this argv ever stops saying that, a fresh terminal loses the
    // learner's work and the cure is worse than the disease.
    const { rt, backend } = await attach(STORED, { id: 'term-old', status: 'exited' });

    const argv = backend.created[0]!.command.join(' ');
    expect(argv).toContain('tmux');
    expect(argv).toContain('new-session -A -s opalix');
    expect(backend.created[0]!.cwd).toBe('/workspace');
    // The stored relaunch argv and the argv actually used must not drift.
    expect((await rt.terminal())!.argv).toEqual(backend.created[0]!.command);
  });

  it('carries the learner\'s last known window size onto the replacement', async () => {
    const { backend } = await attach(STORED, { id: 'term-old', status: 'exited' });
    expect(backend.created[0]!.cols).toBe(100);
    expect(backend.created[0]!.rows).toBe(40);
  });

  it('creates the first terminal when the session has never had one', async () => {
    const { rt, backend } = await attach(undefined, null);
    expect(backend.getTerminalCalls).toHaveLength(0);
    expect(backend.created).toHaveLength(1);
    expect(backend.created[0]!.cols).toBe(120);
    expect(backend.created[0]!.rows).toBe(30);
    expect(await rt.terminal()).toBeDefined();
  });
});
