import { describe, expect, it } from 'vitest';

/**
 * The pure parts of the learner's progress screens (dashboard/src): the two new addresses, the cache the
 * bands and pages draw from, the goal questions' rules, and what the profile and path pages read out of the
 * service's answers. The drawing itself is pinned by test/e2e/22-profile.spec.ts.
 */
const routes = (await import('../../dashboard/src/routes.js' as string)) as {
  parseRoute: (p: string, q?: string) => { name: string; [k: string]: unknown };
  buildRoute: (name: string, params?: Record<string, unknown>) => string;
  routeTitle: (route: unknown) => string;
};
const model = (await import('../../dashboard/src/launcher-model.js' as string)) as {
  breadcrumbs: (m: unknown, route: unknown, lab?: unknown) => Array<{ label: string; route: unknown }>;
};
const store = (await import('../../dashboard/src/live-store.js' as string)) as {
  createLiveStore: (load: () => Promise<unknown>, o?: { ttl?: number; now?: () => number }) => {
    get: () => { status: string; data: unknown; error: unknown };
    ensure: (o?: { force?: boolean }) => Promise<unknown>;
    invalidate: () => void;
    set: (d: unknown) => void;
    reset: () => void;
    subscribe: (fn: (s: unknown) => void) => () => void;
  };
};
const goal = (await import('../../dashboard/src/goal-fields.js' as string)) as {
  parseHours: (v: unknown) => number | null;
  normalizeGoal: (raw: unknown) => { goal_kind: string; goal_text: string; hours_per_week: number };
  areasFromLevels: (l: unknown) => Record<string, string>;
  pathInputsBody: (a: { levels: unknown; goal: unknown }) => Record<string, unknown>;
  loadGoal: (s: unknown) => { goal_kind: string; goal_text: string; hours_per_week: number };
  saveGoal: (g: unknown, s: unknown) => void;
  DEFAULT_GOAL: { goal_kind: string; goal_text: string; hours_per_week: number };
};
const profile = (await import('../../dashboard/src/profile.js' as string)) as {
  startingParam: (l: unknown) => string;
  isNewLearner: (c: unknown) => boolean;
  xpLine: (l: unknown) => string;
  streakText: (s: unknown) => string;
  areaLook: (a: string) => { icon: string; accent: string };
  standingOf: (p: unknown) => { xp: number; scores: Record<string, number> } | null;
  gainBetween: (before: unknown, after: unknown, area: string | null, titleOf?: (id: string) => string) => { xp: number; skill: { title: string; from: number; to: number } | null } | null;
};
const path = (await import('../../dashboard/src/path-view.js' as string)) as {
  normalizePath: (raw: unknown) => null | { steps: Array<{ slug: string; status: string; minutes: number; why: string; lock: string | null }>; totalMinutes: number; weeks: number; goal: { text: string; kind: string } };
  nextStep: (p: unknown) => { slug: string } | null;
  comingUp: (p: unknown, n?: number) => Array<{ slug: string }>;
  totalsLine: (p: unknown) => string;
  goalKindLabel: (k: string) => string;
  LOCK_REASON: string;
  STATUS_WORDS: Record<string, string>;
};

describe('the new addresses', () => {
  it('reads /profile and /paths/mine, with trailing slashes and a query', () => {
    expect(routes.parseRoute('/profile').name).toBe('profile');
    expect(routes.parseRoute('/profile/').name).toBe('profile');
    expect(routes.parseRoute('/profile', '?x=1')).toMatchObject({ name: 'profile', search: '?x=1' });
    expect(routes.parseRoute('/paths/mine').name).toBe('my-path');
    expect(routes.parseRoute('/paths/mine/').name).toBe('my-path');
  });

  it('keeps `mine` out of the paths: it is never a learning path or the start of a module address', () => {
    expect(routes.parseRoute('/paths/mine/modules/1').name).toBe('not-found');
    expect(routes.parseRoute('/paths/mine/x').name).toBe('not-found');
    expect(routes.parseRoute('/paths/mine-too').name).toBe('path');
    expect(routes.parseRoute('/profile/x').name).toBe('not-found');
  });

  it('builds them back, and titles them', () => {
    expect(routes.buildRoute('profile')).toBe('/profile');
    expect(routes.buildRoute('my-path')).toBe('/paths/mine');
    expect(routes.buildRoute('my-path', { search: '?a=b' })).toBe('/paths/mine?a=b');
    expect(routes.routeTitle({ name: 'profile' })).toBe('Your profile · Opalix labs');
    expect(routes.routeTitle({ name: 'my-path' })).toBe('Your path · Opalix labs');
  });

  it('draws the trail Home > Profile and Home > Your path, the page being the last, not a link', () => {
    const profileTrail = model.breadcrumbs(null, { name: 'profile' });
    expect(profileTrail.map((i) => i.label)).toEqual(['Home', 'Profile']);
    expect(profileTrail[0]!.route).toEqual({ name: 'launcher' });
    expect(profileTrail[1]!.route).toBeNull();
    const pathTrail = model.breadcrumbs(null, { name: 'my-path' });
    expect(pathTrail.map((i) => i.label)).toEqual(['Home', 'Your path']);
    expect(pathTrail[1]!.route).toBeNull();
  });
});

describe('createLiveStore', () => {
  const deferred = () => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
    return { promise, resolve, reject };
  };

  it('loads once for overlapping asks, then answers from what it holds until it is old or invalidated', async () => {
    let calls = 0;
    let clock = 0;
    const s = store.createLiveStore(async () => ({ n: ++calls }), { ttl: 1000, now: () => clock });
    await Promise.all([s.ensure(), s.ensure()]);
    expect(calls).toBe(1);
    expect(s.get()).toMatchObject({ status: 'ready', data: { n: 1 } });
    await s.ensure();
    expect(calls).toBe(1);
    clock = 1500;
    await s.ensure();
    expect(calls).toBe(2);
    s.invalidate();
    await s.ensure();
    expect(calls).toBe(3);
    await s.ensure({ force: true });
    expect(calls).toBe(4);
  });

  it('keeps the last good answer when a refresh fails, and says so', async () => {
    let fail = false;
    const s = store.createLiveStore(async () => {
      if (fail) throw Object.assign(new Error('500: no'), { status: 500 });
      return { ok: 1 };
    });
    await s.ensure();
    fail = true;
    await s.ensure({ force: true });
    expect(s.get()).toMatchObject({ status: 'error', data: { ok: 1 }, error: { status: 500 } });
  });

  it('keeps the error of a first load that fails (a 404 is the caller\'s to read)', async () => {
    const s = store.createLiveStore(async () => {
      throw Object.assign(new Error('404: none'), { status: 404 });
    });
    await s.ensure();
    expect(s.get()).toMatchObject({ status: 'error', data: null, error: { status: 404 } });
  });

  it('drops the answer of a request that was overtaken by set() or invalidate()', async () => {
    const slow = deferred();
    const s = store.createLiveStore(() => slow.promise);
    const pending = s.ensure();
    s.set({ fresh: true });
    slow.resolve({ stale: true });
    await pending;
    expect(s.get().data).toEqual({ fresh: true });

    const slow2 = deferred();
    const t = store.createLiveStore(() => slow2.promise);
    const pending2 = t.ensure();
    t.invalidate();
    slow2.resolve({ old: true });
    await pending2;
    expect(t.get().data).toBeNull();
  });

  it('tells subscribers, and lets go of one that unsubscribes or throws', async () => {
    const s = store.createLiveStore(async () => 1);
    const seen: string[] = [];
    const off = s.subscribe((st) => seen.push((st as { status: string }).status));
    s.subscribe(() => {
      throw new Error('a broken screen');
    });
    await s.ensure();
    expect(seen).toEqual(['loading', 'ready']);
    off();
    s.set(2);
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('reset() forgets everything', async () => {
    const s = store.createLiveStore(async () => 'x');
    await s.ensure();
    s.reset();
    expect(s.get()).toMatchObject({ status: 'idle', data: null });
  });
});

describe('the goal questions', () => {
  it('takes only whole hours from 1 to 20', () => {
    for (const ok of ['1', '4', ' 12 ', '20', 7]) expect(goal.parseHours(ok), String(ok)).toBe(Number(ok));
    for (const bad of ['', '0', '21', '2.5', '-3', 'ten', '1e1', '007x', null, undefined, '100']) expect(goal.parseHours(bad), String(bad)).toBeNull();
  });

  it('falls back to Explore and 4 hours for what does not fit', () => {
    expect(goal.normalizeGoal(null)).toEqual(goal.DEFAULT_GOAL);
    expect(goal.normalizeGoal({ goal_kind: 'fun', hours_per_week: 99, goal_text: 5 })).toEqual(goal.DEFAULT_GOAL);
    expect(goal.normalizeGoal({ goal_kind: 'role-ready', goal_text: '  Run   it \n now ', hours_per_week: 6 })).toEqual({ goal_kind: 'role-ready', goal_text: 'Run it now', hours_per_week: 6 });
    expect(goal.normalizeGoal({ goal_text: 'x'.repeat(300) }).goal_text).toHaveLength(200);
  });

  it('remembers the last answers in storage, and copes with storage that is blocked or holds junk', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    goal.saveGoal({ goal_kind: 'specific-skill', goal_text: 'RAG', hours_per_week: 10 }, storage);
    expect(goal.loadGoal(storage)).toEqual({ goal_kind: 'specific-skill', goal_text: 'RAG', hours_per_week: 10 });
    mem.set('opalixPathGoal', '{not json');
    expect(goal.loadGoal(storage)).toEqual(goal.DEFAULT_GOAL);
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(goal.loadGoal(blocked)).toEqual(goal.DEFAULT_GOAL);
    expect(() => goal.saveGoal(goal.DEFAULT_GOAL, blocked)).not.toThrow();
  });

  it('sends the quiz result as areas (ok stays ok) with the goal, and leaves an empty goal line out', () => {
    const levels = { gateway: 'new', mcp: 'ok', rag: 'strong', 'bad/area': 'new', otel: 'expert' };
    expect(goal.areasFromLevels(levels)).toEqual({ gateway: 'new', mcp: 'ok', rag: 'strong' });
    expect(goal.areasFromLevels(null)).toEqual({});
    expect(goal.pathInputsBody({ levels, goal: { goal_kind: 'explore', goal_text: '', hours_per_week: 4 } })).toEqual({
      areas: { gateway: 'new', mcp: 'ok', rag: 'strong' },
      goal_kind: 'explore',
      hours_per_week: 4,
    });
    expect(goal.pathInputsBody({ levels: {}, goal: { goal_kind: 'role-ready', goal_text: 'Run the gateway', hours_per_week: 2 } })).toEqual({
      areas: {},
      goal_kind: 'role-ready',
      goal_text: 'Run the gateway',
      hours_per_week: 2,
    });
  });
});

describe('the profile, as the page reads it', () => {
  it('builds ?starting= from the quiz levels, only the three levels and plain area names', () => {
    expect(profile.startingParam({ gateway: 'ok', mcp: 'new', rag: 'strong' })).toBe('gateway:ok,mcp:new,rag:strong');
    expect(profile.startingParam({ gateway: 'familiar', 'x/y': 'new', Rag: 'new', otel: 'new' })).toBe('otel:new');
    expect(profile.startingParam(null)).toBe('');
    expect(profile.startingParam({})).toBe('');
  });

  it('knows a brand-new learner from one with something to show', () => {
    expect(profile.isNewLearner({ xp: 0, overall: { score: 0 }, recent_awards: [] })).toBe(true);
    expect(profile.isNewLearner({ xp: 5, overall: { score: 0 }, recent_awards: [] })).toBe(false);
    expect(profile.isNewLearner({ xp: 0, overall: { score: 3 }, recent_awards: [] })).toBe(false);
    expect(profile.isNewLearner({ xp: 0, overall: { score: 0 }, recent_awards: [{ id: 'a' }] })).toBe(false);
  });

  it('says the XP and the streak in words', () => {
    // XP has ranks; "level" is the word for a skill's score, so the two are never confused.
    expect(profile.xpLine({ n: 3, xp_into: 25, xp_needed: 250 })).toBe('25 of 250 XP to the next rank');
    expect(profile.xpLine({ n: 10, xp_into: 400, xp_needed: 0 })).toBe('Top rank reached');
    expect(profile.streakText({ days: 2 })).toBe('2-day streak');
    expect(profile.streakText({ days: 0, best: 5 })).toBe('No streak yet');
    expect(profile.streakText(undefined)).toBe('No streak yet');
  });

  it('compares a learner before and after a lab: the XP gained and the skill that moved', () => {
    const at = (xp: number, scores: Record<string, number>) => ({ xp, skills: Object.entries(scores).map(([area, score]) => ({ area, score })) });
    const before = profile.standingOf(at(100, { rag: 12, otel: 0 }));
    expect(before).toEqual({ xp: 100, scores: { rag: 12, otel: 0 } });
    const after = profile.standingOf(at(220, { rag: 31, otel: 0 }));
    expect(profile.gainBetween(before, after, 'rag', (id) => `T-${id}`)).toEqual({ xp: 120, skill: { title: 'T-rag', from: 12, to: 31 } });
    // The lab fed another skill: only the XP is said.
    expect(profile.gainBetween(before, after, 'otel')).toEqual({ xp: 120, skill: null });
    // Nothing moved, or nothing to compare with: nothing is said.
    expect(profile.gainBetween(before, before, 'rag')).toBeNull();
    expect(profile.gainBetween(null, after, 'rag')).toBeNull();
    expect(profile.gainBetween(before, after, null)?.skill).toBeNull();
  });

  it('reads no standing from an answer that is not a profile', () => {
    for (const bad of [null, undefined, 3, {}, { skills: 'no' }]) expect(profile.standingOf(bad)).toBeNull();
  });

  it('gives every skill the icon and colour of its module, or of its path', () => {
    for (const area of ['agents', 'security', 'gateway', 'mcp', 'rag', 'otel', 'runtime', 'platform', 'sovereignty', 'evals']) {
      const look = profile.areaLook(area);
      expect(look.icon, area).toBeTruthy();
      expect(['blue', 'teal', 'green', 'amber', 'rose', 'violet', 'indigo', 'slate'], area).toContain(look.accent);
    }
    expect(profile.areaLook('nope')).toEqual({ icon: 'grid', accent: 'slate' });
  });
});

describe('the path, as the page reads it', () => {
  const step = (slug: string, status: string, o: Record<string, unknown> = {}) => ({ slug, title: slug.toUpperCase(), area: 'gateway', why: `why ${slug}`, estimated_minutes: 20, status, ...o });
  const raw = {
    steps: [step('a', 'done'), step('b', 'next'), step('c', 'upcoming'), step('d', 'upcoming'), step('e', 'upcoming'), step('f', 'upcoming'), step('g', 'locked')],
    total_minutes: 90,
    weeks_estimate: 2,
    goal: { text: 'Run our gateway', kind: 'role-ready' },
  };

  it('keeps the service\'s order and finds the next step and the three after it', () => {
    const p = path.normalizePath(raw)!;
    expect(p.steps.map((s) => s.slug)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(path.nextStep(p)!.slug).toBe('b');
    expect(path.comingUp(p).map((s) => s.slug)).toEqual(['c', 'd', 'e']);
    expect(path.comingUp(p, 1).map((s) => s.slug)).toEqual(['c']);
  });

  it('has no next step when everything is done or locked', () => {
    const p = path.normalizePath({ steps: [step('a', 'done'), step('g', 'locked')], total_minutes: 0, weeks_estimate: 0 })!;
    expect(path.nextStep(p)).toBeNull();
    expect(path.comingUp(p)).toEqual([]);
  });

  it('reads why a step is locked: the service\'s lock, else the stock plan line as a plan lock, else unknown', () => {
    const lockOf = (o: Record<string, unknown>) => path.normalizePath({ steps: [step('g', 'locked', o)] })!.steps[0]!.lock;
    expect(lockOf({ lock: 'plan', why: 'This lab is included with the Pro plan.' })).toBe('plan');
    expect(lockOf({ why: 'This lab is included with the Pro plan.' })).toBe('plan');
    expect(lockOf({ lock: 'plan', why: 'Included with the Pro plan.' })).toBe('plan');
    expect(lockOf({ lock: 'prerequisite', why: 'Included with the Pro plan.' })).toBe('prerequisite');
    expect(lockOf({ why: 'Included with the Pro plan.' })).toBe('plan'); // an older response
    expect(lockOf({ why: 'Unlocks after A.' })).toBeNull();
    expect(lockOf({ lock: 'whatever', why: 'Unlocks after A.' })).toBeNull();
    expect(path.normalizePath({ steps: [step('a', 'next', { lock: 'plan' })] })!.steps[0]!.lock).toBeNull();
  });

  it('drops steps that are not well formed and reads nothing from a body that is not a path', () => {
    const p = path.normalizePath({ steps: [step('ok', 'next'), step('Bad Slug', 'next'), step('x', 'whenever'), null, { slug: 5 }], total_minutes: 'x' })!;
    expect(p.steps.map((s) => s.slug)).toEqual(['ok']);
    expect(p.totalMinutes).toBe(0);
    for (const bad of [null, undefined, 4, {}, { steps: 'no' }]) expect(path.normalizePath(bad)).toBeNull();
  });

  it('says the time left and the weeks, or that nothing is left', () => {
    expect(path.totalsLine(path.normalizePath(raw)!)).toBe('1 h 30 min to go · about 2 weeks');
    expect(path.totalsLine(path.normalizePath({ ...raw, total_minutes: 30, weeks_estimate: 1 })!)).toBe('30 min to go · about 1 week');
    expect(path.totalsLine(path.normalizePath({ ...raw, total_minutes: 0, weeks_estimate: 0 })!)).toBe('Nothing left to do on this path.');
  });

  it('names the goal kinds, and gives the lock a plain reason', () => {
    expect(path.goalKindLabel('role-ready')).toBe('Be ready for a role');
    expect(path.goalKindLabel('specific-skill')).toBe('Learn a specific skill');
    expect(path.goalKindLabel('explore')).toBe('Explore');
    expect(path.goalKindLabel('what')).toBe('Explore');
    expect(path.LOCK_REASON).toBe('This lab is included with the Pro plan.');
    expect(path.STATUS_WORDS).toEqual({ done: 'Done', next: 'Next up', upcoming: 'Not started', locked: 'Locked' });
  });
});
