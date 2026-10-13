import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Saving the learner's place in "Before you begin" and a warm-up (dashboard/src/learn-progress.js): the flow
 * store that keeps the visit in sessionStorage and sends it to the server, debounced, at once on a step
 * change and as the page is hidden; the reading of a saved place back against the bundle; and the client's
 * short memory. Pure module, with fake storage, timers, events and API.
 */

type Step = Record<string, unknown> & { kind: string };
type State = { v: 1; steps: Step[]; at: number; answers: Record<string, unknown>; games?: Record<string, unknown>; started_at?: number; lessons?: Record<string, unknown>; label?: string };
type Progress = { version: string; state: State } | null;
type Remote = {
  get: (slug: string, o?: { fresh?: boolean }) => Promise<Progress>;
  save: (slug: string, body: { version: string; state: State }, o?: { keepalive?: boolean }) => Promise<boolean>;
  clear: (slug: string, o?: { keepalive?: boolean }) => Promise<boolean>;
  peek: (slug: string) => Progress | undefined;
};
const m = (await import('../../dashboard/src/learn-progress.js' as string)) as {
  LESSON_PAGES_KEY: string;
  SAVE_DELAY_MS: number;
  worthResuming: (state: unknown) => boolean;
  progressSummary: (p: { at: number; total: number; label?: string }) => string;
  resumePoint: (entry: unknown, progress: unknown) => { state: State; at: number; total: number; label: string } | null;
  pagePoint: (lab: unknown, progress: unknown) => { at: number; total: number; label: string } | null;
  lessonPagesFor: (slug: string, storage?: unknown) => { load: () => unknown; save: (v: unknown) => void };
  createProgressClient: (api: unknown, o?: { ttl?: number; now?: () => number }) => Remote;
  createProgressStore: (o: Record<string, unknown>) => {
    load: () => { steps: Step[]; answers: Record<string, unknown>; games: Record<string, unknown>; started_at?: number } | null;
    save: (steps: Step[], answers: Record<string, unknown>, extra?: { games?: Record<string, unknown>; started_at?: number; at?: number }) => void;
    flush: (o?: { keepalive?: boolean }) => void;
    seed: (state: unknown) => void;
    clear: () => void;
    finish: () => void;
    settled: () => Promise<unknown>;
  };
};

function webStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

/** A thing to listen on: `fire(type)` calls what was added and not removed. */
function target(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    ...extra,
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    fire: (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

const LEARN = {
  story: { title: 'The night the gateway went down' },
  concepts: [
    { id: 'gateway.alias', title: 'Aliases' },
    { id: 'gateway.fallback', title: 'Fallbacks' },
  ],
  questions: [
    { id: 'q1', concept: 'gateway.alias' },
    { id: 'q2', concept: 'gateway.fallback' },
  ],
  games: [{ id: 'sort-calls', title: 'Who pays?' }],
  closing: { story: { title: 'Case closed' } },
};
const STEPS: Step[] = [
  { kind: 'story' },
  { kind: 'round', round: 1, rounds: 1, questions: ['q1', 'q2'] },
  { kind: 'lessons', part: 1, parts: 1, concepts: ['gateway.alias', 'gateway.fallback'], plan: [] },
  { kind: 'story', closing: true },
  { kind: 'game', game: 'sort-calls' },
];
const ANSWER = { question_id: 'q1', concept: 'gateway.alias', correct: true, selected: ['a'] };
const state = (o: Partial<State> = {}): State => ({ v: 1, steps: STEPS, at: 2, answers: { q1: ANSWER }, ...o });

/** A remote that records what it was sent; each call resolves when `release` is called (or at once). */
function fakeRemote({ hold = false } = {}) {
  const sent: Array<{ op: 'save' | 'clear'; body?: { version: string; state: State }; keepalive: boolean }> = [];
  const pending: Array<() => void> = [];
  const wait = () => (hold ? new Promise<boolean>((resolve) => pending.push(() => resolve(true))) : Promise.resolve(true));
  const remote = {
    get: vi.fn(async () => null),
    save: vi.fn((_slug: string, body: { version: string; state: State }, o: { keepalive?: boolean } = {}) => {
      sent.push({ op: 'save', body: JSON.parse(JSON.stringify(body)), keepalive: o.keepalive === true });
      return wait();
    }),
    clear: vi.fn((_slug: string, o: { keepalive?: boolean } = {}) => {
      sent.push({ op: 'clear', keepalive: o.keepalive === true });
      return wait();
    }),
    peek: () => undefined,
  };
  return { remote, sent, release: () => pending.shift()?.() };
}

function setup(opts: { hold?: boolean; version?: string } = {}) {
  const session = webStorage();
  const local = webStorage();
  const win = target();
  const doc = target({ visibilityState: 'visible' });
  const { remote, sent, release } = fakeRemote({ hold: opts.hold });
  const store = m.createProgressStore({
    slug: 'gateway-one-night',
    version: opts.version ?? '1.0.0',
    learn: LEARN,
    storage: session,
    pagesStorage: local,
    remote,
    events: { window: win, document: doc },
  });
  return { store, session, local, win, doc, remote, sent, release };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createProgressStore', () => {
  it('keeps the visit in sessionStorage at once, as before (a refresh of the tab reads it)', () => {
    const { store, session } = setup();
    store.save(STEPS, {}, { at: 0 });
    expect(store.load()).toMatchObject({ steps: STEPS, answers: {} });
    expect([...session.data.keys()]).toEqual(['opalix.flow.gateway-one-night']);
  });

  it('sends nothing until there is something worth coming back to', async () => {
    const { store, sent } = setup();
    store.save(STEPS, {}, { at: 0 });
    store.save(STEPS, {});
    await vi.advanceTimersByTimeAsync(5000);
    store.flush();
    await store.settled();
    expect(sent).toEqual([]);
  });

  it('sends a new step at once, and anything else one second after the last change (debounced)', async () => {
    const { store, sent } = setup();
    store.save(STEPS, {}, { at: 0 });
    store.save(STEPS, {}, { at: 1 });
    await store.settled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ version: '1.0.0', state: { v: 1, steps: STEPS, at: 1, answers: {}, label: 'Questions' } });

    // Two answers in quick succession: one save, a second after the last.
    store.save(STEPS, { q1: ANSWER });
    await vi.advanceTimersByTimeAsync(600);
    store.save(STEPS, { q1: ANSWER, q2: { ...ANSWER, question_id: 'q2', concept: 'gateway.fallback' } });
    await vi.advanceTimersByTimeAsync(m.SAVE_DELAY_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await store.settled();
    expect(sent).toHaveLength(2);
    expect(Object.keys(sent[1]!.body!.state.answers)).toEqual(['q1', 'q2']);
    expect(sent[1]!.body!.state.at).toBe(1);

    // Nothing changed: nothing sent.
    store.save(STEPS, { q1: ANSWER, q2: { ...ANSWER, question_id: 'q2', concept: 'gateway.fallback' } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(2);
  });

  it('a save that names no step (the flow opening on a refreshed visit) waits, and the step that follows goes alone', async () => {
    const { store, sent } = setup();
    store.save(STEPS, { q1: ANSWER });
    await store.settled();
    expect(sent).toHaveLength(0);
    store.save(STEPS, { q1: ANSWER }, { at: 2 });
    await store.settled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.map((s) => s.body!.state.at)).toEqual([2]);
  });

  it("carries a warm-up's games and start time, the lesson pages and the step's name", async () => {
    const { store, sent, local } = setup();
    local.setItem(m.LESSON_PAGES_KEY, JSON.stringify({ 'gateway-one-night': { at: {}, pages: { 'gateway.alias': 2 }, read: ['gateway.alias'] }, 'other-lab': { at: {}, pages: {}, read: [] } }));
    store.save(STEPS, {}, { games: { 'sort-calls': { id: 'sort-calls', tries: 2 } }, started_at: 1234, at: 4 });
    await store.settled();
    expect(sent[0]!.body!.state).toEqual({
      v: 1,
      steps: STEPS,
      at: 4,
      answers: {},
      games: { 'sort-calls': { id: 'sort-calls', tries: 2 } },
      started_at: 1234,
      lessons: { at: {}, pages: { 'gateway.alias': 2 }, read: ['gateway.alias'] },
      label: 'Who pays?',
    });
  });

  it('sends a lesson page turned since the last save when the page is hidden or closed, with keepalive', async () => {
    const { store, sent, local, win, doc } = setup();
    store.save(STEPS, { q1: ANSWER }, { at: 2 });
    await store.settled();
    expect(sent).toHaveLength(1);
    local.setItem(m.LESSON_PAGES_KEY, JSON.stringify({ 'gateway-one-night': { at: {}, pages: { 'gateway.alias': 1 }, read: [] } }));
    doc.fire('visibilitychange'); // still visible: nothing
    expect(sent).toHaveLength(1);
    (doc as unknown as { visibilityState: string }).visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ op: 'save', keepalive: true });
    expect(sent[1]!.body!.state.lessons).toEqual({ at: {}, pages: { 'gateway.alias': 1 }, read: [] });
    win.fire('pagehide'); // nothing new since
    expect(sent).toHaveLength(2);
  });

  it('clear() ends the visit: what changed is sent, the listeners go, the local copy goes, the server keeps it', async () => {
    const { store, sent, session, win, doc } = setup();
    store.save(STEPS, { q1: ANSWER }, { at: 2 });
    store.save(STEPS, { q1: ANSWER, q2: ANSWER });
    store.clear();
    await store.settled();
    expect(sent.map((s) => s.op)).toEqual(['save', 'save']);
    expect(Object.keys(sent[1]!.body!.state.answers)).toEqual(['q1', 'q2']);
    expect(session.data.size).toBe(0);
    expect(win.count('pagehide')).toBe(0);
    expect(doc.count('visibilitychange')).toBe(0);
    // The debounce that was pending does not fire later.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(2);
  });

  it('finish() forgets it here and on the server, after any save still under way, and sends nothing more', async () => {
    const { store, sent, session, release } = setup({ hold: true });
    store.save(STEPS, { q1: ANSWER }, { at: 2 });
    store.save(STEPS, { q1: ANSWER }, { at: 3 });
    store.finish();
    // The DELETE waits its turn behind both saves.
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.op)).toEqual(['save']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.op)).toEqual(['save', 'save', 'clear']);
    release();
    expect(session.data.size).toBe(0);
    store.save(STEPS, { q1: ANSWER }, { at: 4 });
    store.clear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(3);
  });

  it('seed() makes a saved state this visit: the local copy, the lesson pages, and nothing sent until it changes', async () => {
    const { store, sent, local } = setup();
    const saved = state({ at: 3, lessons: { at: {}, pages: { 'gateway.alias': 1 }, read: ['gateway.alias'] }, label: 'Case closed' });
    store.seed(saved);
    expect(store.load()).toMatchObject({ steps: STEPS, answers: { q1: ANSWER } });
    expect(JSON.parse(local.getItem(m.LESSON_PAGES_KEY)!)['gateway-one-night']).toEqual(saved.lessons);
    // The flow saves the same visit as it opens on the same step: nothing to send.
    store.save(STEPS, { q1: ANSWER });
    store.save(STEPS, { q1: ANSWER }, { at: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
    store.save(STEPS, { q1: ANSWER }, { at: 4 });
    await store.settled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body!.state.at).toBe(4);
  });

  it('works with no remote at all (local only, as before)', async () => {
    const session = webStorage();
    const store = m.createProgressStore({ slug: 'x-lab', version: '1', storage: session, pagesStorage: webStorage(), events: { window: target(), document: target() } });
    store.save(STEPS, { q1: ANSWER }, { at: 2 });
    store.flush();
    store.finish();
    expect(session.data.size).toBe(0);
  });

  it('a local copy from another version is not read back', () => {
    const session = webStorage();
    const opts = { slug: 'x-lab', storage: session, pagesStorage: webStorage(), events: { window: target(), document: target() } };
    m.createProgressStore({ ...opts, version: '1.0.0' }).save(STEPS, {}, { at: 1 });
    expect(m.createProgressStore({ ...opts, version: '1.0.0' }).load()).not.toBeNull();
    expect(m.createProgressStore({ ...opts, version: '2.0.0' }).load()).toBeNull();
  });
});

describe('resumePoint (a saved place read back against the bundle)', () => {
  const entry = { version: '1.0.0', learn: LEARN };

  it('is where to continue: the step, the number of steps, and the step name', () => {
    expect(m.resumePoint(entry, { version: '1.0.0', state: state() })).toEqual({ state: state(), at: 2, total: 5, label: 'Lessons' });
    expect(m.resumePoint(entry, { version: '1.0.0', state: state({ at: 4, answers: {} }) })).toMatchObject({ at: 4, label: 'Who pays?' });
  });

  it('is null (start over) when the version changed, or the steps no longer fit the bundle', () => {
    expect(m.resumePoint(entry, { version: '0.9.0', state: state() })).toBeNull();
    const gone = { ...LEARN, questions: [LEARN.questions[0]] };
    expect(m.resumePoint({ version: '1.0.0', learn: gone }, { version: '1.0.0', state: state() })).toBeNull();
    const noGames = { ...LEARN, games: [] };
    expect(m.resumePoint({ version: '1.0.0', learn: noGames }, { version: '1.0.0', state: state() })).toBeNull();
  });

  it('is null when there is nothing worth continuing, and never throws on junk', () => {
    expect(m.resumePoint(entry, null)).toBeNull();
    expect(m.resumePoint(entry, { version: '1.0.0', state: state({ at: 0, answers: {} }) })).toBeNull();
    for (const junk of [{}, { version: '1.0.0' }, { version: '1.0.0', state: { v: 1, steps: 'x', at: 2 } }, { version: '1.0.0', state: { v: 1, steps: [null], at: 1 } }, { version: '1.0.0', state: { v: 2, steps: STEPS, at: 1 } }]) {
      expect(m.resumePoint(entry, junk)).toBeNull();
    }
    expect(m.resumePoint(null, { version: '1.0.0', state: state() })).toBeNull();
  });

  it('keeps a step number past the end on the last step', () => {
    expect(m.resumePoint(entry, { version: '1.0.0', state: state({ at: 40 }) })).toMatchObject({ at: 4 });
  });
});

describe('pagePoint and progressSummary (the lab page, which has no bundle)', () => {
  it('needs the catalogue version and something worth continuing, and uses the saved name', () => {
    const lab = { slug: 'gateway-one-night', version: '1.0.0' };
    expect(m.pagePoint(lab, { version: '1.0.0', state: state({ label: 'Lessons' }) })).toEqual({ at: 2, total: 5, label: 'Lessons' });
    expect(m.pagePoint(lab, { version: '1.1.0', state: state() })).toBeNull();
    expect(m.pagePoint(lab, { version: '1.0.0', state: state({ at: 0, answers: {} }) })).toBeNull();
    expect(m.pagePoint(lab, null)).toBeNull();
  });

  it('says "Step n of m: <name>"', () => {
    expect(m.progressSummary({ at: 2, total: 7, label: 'Lessons, part 1 of 2' })).toBe('Step 3 of 7: Lessons, part 1 of 2');
    expect(m.progressSummary({ at: 0, total: 1, label: '' })).toBe('Step 1 of 1');
  });

  it('worthResuming: past the first step, an answer, a game or a lesson read', () => {
    expect(m.worthResuming(state({ at: 0, answers: {} }))).toBe(false);
    expect(m.worthResuming(state({ at: 1, answers: {} }))).toBe(true);
    expect(m.worthResuming(state({ at: 0 }))).toBe(true);
    expect(m.worthResuming(state({ at: 0, answers: {}, games: { g: {} } }))).toBe(true);
    expect(m.worthResuming(state({ at: 0, answers: {}, lessons: { read: ['gateway.alias'] } }))).toBe(true);
    expect(m.worthResuming(null)).toBe(false);
  });
});

describe('createProgressClient', () => {
  it('remembers what it read or sent for a short while, and reads again after', async () => {
    let t = 0;
    const saved = { version: '1.0.0', state: state(), updated_at: 5 };
    const api = {
      learnProgress: vi.fn(async () => ({ progress: saved })),
      saveLearnProgress: vi.fn(async () => ({ saved: true })),
      clearLearnProgress: vi.fn(async () => ({ deleted: true })),
    };
    const c = m.createProgressClient(api, { ttl: 1000, now: () => t });
    expect(await c.get('lab')).toEqual({ version: '1.0.0', state: state() });
    expect(await c.get('lab')).toEqual({ version: '1.0.0', state: state() });
    expect(api.learnProgress).toHaveBeenCalledTimes(1);

    await c.save('lab', { version: '1.0.0', state: state({ at: 3 }) }, { keepalive: true });
    expect(api.saveLearnProgress).toHaveBeenCalledWith('lab', { version: '1.0.0', state: state({ at: 3 }) }, { keepalive: true });
    expect((await c.get('lab'))!.state.at).toBe(3);

    await c.clear('lab');
    expect(await c.get('lab')).toBeNull();
    expect(api.learnProgress).toHaveBeenCalledTimes(1);
    t = 2000;
    expect(await c.get('lab')).toEqual({ version: '1.0.0', state: state() });
    expect(api.learnProgress).toHaveBeenCalledTimes(2);
  });

  it('a failed call is no progress and never throws', async () => {
    const api = {
      learnProgress: vi.fn(async () => {
        throw new Error('502');
      }),
      saveLearnProgress: vi.fn(async () => {
        throw new Error('400');
      }),
      clearLearnProgress: vi.fn(async () => {
        throw new Error('502');
      }),
    };
    const c = m.createProgressClient(api);
    expect(await c.get('lab')).toBeNull();
    expect(await c.save('lab', { version: '1', state: state() })).toBe(false);
    // The server does not have it, so it is not remembered either.
    expect(c.peek('lab')).toBeUndefined();
    expect(await c.clear('lab')).toBe(false);
    expect(c.peek('lab')).toBeUndefined();
  });
});

describe('the lesson pages key', () => {
  it('is the lessons pager’s own (learn-lessons.js)', async () => {
    const lessons = (await import('../../dashboard/src/learn-lessons.js' as string)) as { PAGES_KEY: string };
    expect(m.LESSON_PAGES_KEY).toBe(lessons.PAGES_KEY);
  });

  it('reads and writes one lab’s memory, leaving the others', () => {
    const local = webStorage();
    local.setItem(m.LESSON_PAGES_KEY, JSON.stringify({ other: { read: ['x'] } }));
    const pages = m.lessonPagesFor('mine', local);
    expect(pages.load()).toBeNull();
    pages.save({ at: {}, pages: { a: 1 }, read: [] });
    expect(JSON.parse(local.getItem(m.LESSON_PAGES_KEY)!)).toEqual({ other: { read: ['x'] }, mine: { at: {}, pages: { a: 1 }, read: [] } });
    local.setItem(m.LESSON_PAGES_KEY, '{not json');
    expect(pages.load()).toBeNull();
  });
});
