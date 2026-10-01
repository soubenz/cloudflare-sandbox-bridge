import { describe, it, expect } from 'vitest';

/**
 * The session screen's layout decisions (dashboard/src/session-layout.js):
 * which tabs a lab's guide has, whether it starts open, how the arrow keys walk
 * a row of tabs and what the badges, the rail and the dock say. Pure module.
 */
const L = (await import('../../dashboard/src/session-layout.js' as string)) as {
  GUIDE_OPEN_MIN_WIDTH: number;
  defaultGuideOpen: (width: unknown) => boolean;
  guideTabsFor: (o?: Record<string, unknown>) => string[];
  dockKind: (tabs: string[]) => 'answers' | 'checks';
  roveIndex: (key: string, index: number, count: number) => number | null;
  tabBadge: (id: string, c?: Record<string, unknown>) => { text: string; label: string } | null;
  railLabel: (id: string, badge: { label: string } | null) => string;
  checkDots: (results: unknown, planned?: number) => string[];
  answerDots: (answered: number, total: number) => string[];
  hintCountdown: (o?: { locked?: Array<number | null>; slots?: number }) => string;
  dockAction: (o?: Record<string, unknown>) => { label: string; action: string };
  dockProgressText: (o?: Record<string, unknown>) => string;
  windowTitle: (o: { view: string; file?: string; service?: string }) => string;
};

describe('defaultGuideOpen', () => {
  it('is open from 1180px up and collapsed below', () => {
    expect(L.GUIDE_OPEN_MIN_WIDTH).toBe(1180);
    for (const w of [1180, 1280, 1440, 1920, 2560]) expect(L.defaultGuideOpen(w)).toBe(true);
    for (const w of [760, 1000, 1024, 1179, 1179.5]) expect(L.defaultGuideOpen(w)).toBe(false);
  });

  it('is open when the width is unknown, so a missing window never hides the guide', () => {
    for (const w of [undefined, null, NaN, 'wide']) expect(L.defaultGuideOpen(w)).toBe(true);
  });
});

describe('guideTabsFor', () => {
  it('opens a build lab on its Brief, with no Story tab', () => {
    expect(L.guideTabsFor({ type: 'build' })).toEqual(['brief', 'checks', 'hints']);
    expect(L.guideTabsFor({ type: 'break-fix' })).toEqual(['brief', 'checks', 'hints']);
  });

  it('gives a build lab a Lessons tab only when it has learning content', () => {
    expect(L.guideTabsFor({ type: 'build', lessons: true })).toEqual(['brief', 'lessons', 'checks', 'hints']);
    expect(L.guideTabsFor({ type: 'build', lessons: false })).not.toContain('lessons');
  });

  it('folds a story a build lab ships into its Lessons tab instead of dropping it', () => {
    const tabs = L.guideTabsFor({ type: 'build', story: true, lessons: false });
    expect(tabs).toEqual(['brief', 'lessons', 'checks', 'hints']);
    expect(tabs).not.toContain('story');
    expect(L.guideTabsFor({ type: 'build', story: true, lessons: true })).not.toContain('story');
  });

  it('opens an explore lab on its Story, then Lessons, Brief and Questions', () => {
    const tabs = L.guideTabsFor({ type: 'explore', story: true, lessons: true, questions: true });
    expect(tabs.slice(0, 4)).toEqual(['story', 'lessons', 'brief', 'questions']);
    expect(tabs[0]).toBe('story');
  });

  it('keeps hints (and a solution, when there is one) after those, and drops Checks for graded questions', () => {
    const tabs = L.guideTabsFor({ type: 'explore', story: true, lessons: true, questions: true, solution: true });
    expect(tabs).toEqual(['story', 'lessons', 'brief', 'questions', 'hints', 'solution']);
    expect(tabs).not.toContain('checks');
  });

  it('gives an explore lab without questions a Checks tab, so its results have a home', () => {
    expect(L.guideTabsFor({ type: 'explore', story: true, lessons: true })).toEqual(['story', 'lessons', 'brief', 'checks', 'hints']);
  });

  it('treats an explore lab with no learning content like any other lab', () => {
    expect(L.guideTabsFor({ type: 'explore' })).toEqual(['brief', 'checks', 'hints']);
  });

  it('skips the tabs an explore lab lacks without leaving gaps', () => {
    expect(L.guideTabsFor({ type: 'explore', lessons: true, questions: true })).toEqual(['lessons', 'brief', 'questions', 'hints']);
    expect(L.guideTabsFor({ type: 'explore', questions: true })).toEqual(['brief', 'questions', 'hints']);
  });

  it('adds the Solution only when the API says one exists, and always last', () => {
    expect(L.guideTabsFor({ type: 'build', solution: true }).at(-1)).toBe('solution');
    expect(L.guideTabsFor({ type: 'build', solution: false })).not.toContain('solution');
  });

  it('never repeats a tab, and every tab is one the guide knows', () => {
    const known = new Set(['story', 'lessons', 'brief', 'questions', 'checks', 'hints', 'solution']);
    for (const type of ['explore', 'build', 'break-fix', undefined]) {
      for (const story of [false, true]) for (const lessons of [false, true]) for (const questions of [false, true]) for (const solution of [false, true]) {
        const tabs = L.guideTabsFor({ type, story, lessons, questions, solution });
        expect(new Set(tabs).size).toBe(tabs.length);
        for (const t of tabs) expect(known.has(t)).toBe(true);
        expect(tabs).toContain('brief');
        expect(tabs).toContain('hints');
      }
    }
  });

  it('is safe to call with nothing', () => {
    expect(L.guideTabsFor()).toEqual(['brief', 'checks', 'hints']);
  });
});

describe('dockKind', () => {
  it('counts answers for a lab graded through its questions, checks otherwise', () => {
    expect(L.dockKind(['story', 'lessons', 'brief', 'questions', 'hints'])).toBe('answers');
    expect(L.dockKind(['brief', 'checks', 'hints'])).toBe('checks');
    expect(L.dockKind(['brief', 'questions', 'checks', 'hints'])).toBe('checks');
  });
});

describe('roveIndex', () => {
  it('moves right and left, wrapping at the ends', () => {
    expect(L.roveIndex('ArrowRight', 0, 4)).toBe(1);
    expect(L.roveIndex('ArrowRight', 3, 4)).toBe(0);
    expect(L.roveIndex('ArrowLeft', 2, 4)).toBe(1);
    expect(L.roveIndex('ArrowLeft', 0, 4)).toBe(3);
  });

  it('treats Down like Right and Up like Left', () => {
    expect(L.roveIndex('ArrowDown', 1, 3)).toBe(2);
    expect(L.roveIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('jumps to the ends with Home and End', () => {
    expect(L.roveIndex('Home', 3, 5)).toBe(0);
    expect(L.roveIndex('End', 0, 5)).toBe(4);
  });

  it('ignores every other key, and an empty row', () => {
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) expect(L.roveIndex(key, 1, 4)).toBeNull();
    expect(L.roveIndex('ArrowRight', 0, 0)).toBeNull();
  });

  it('stays put in a row of one', () => {
    expect(L.roveIndex('ArrowRight', 0, 1)).toBe(0);
    expect(L.roveIndex('ArrowLeft', 0, 1)).toBe(0);
  });
});

describe('tabBadge and railLabel', () => {
  it('says how many lessons are read', () => {
    expect(L.tabBadge('lessons', { read: 2, total: 4 })).toEqual({ text: '2/4', label: '2 of 4 read' });
    expect(L.tabBadge('lessons', { read: 0, total: 0 })).toBeNull();
  });

  it('says how many questions are answered', () => {
    expect(L.tabBadge('questions', { answered: 2, total: 3 })).toEqual({ text: '2/3', label: '2 of 3 answered' });
  });

  it('says how many checks pass, and nothing before there are any', () => {
    expect(L.tabBadge('checks', { passed: 1, count: 3 })).toEqual({ text: '1/3', label: '1 of 3 passing' });
    expect(L.tabBadge('checks', { passed: 0, count: 0 })).toBeNull();
    expect(L.tabBadge('checks', {})).toBeNull();
  });

  it('says how many hints have come', () => {
    expect(L.tabBadge('hints', { delivered: 1, slots: 3 })).toEqual({ text: '1/3', label: '1 of 3 shown' });
    expect(L.tabBadge('hints', { delivered: 0, slots: 0 })).toBeNull();
  });

  it('labels the solution locked or unlocked, and is silent when it is not known', () => {
    expect(L.tabBadge('solution', { unlocked: false })).toEqual({ text: '', label: 'locked' });
    expect(L.tabBadge('solution', { unlocked: true })).toEqual({ text: 'Ready', label: 'unlocked' });
    expect(L.tabBadge('solution', {})).toBeNull();
  });

  it('has no badge for the tabs that count nothing', () => {
    for (const id of ['story', 'brief', 'nope']) expect(L.tabBadge(id, { read: 1, total: 2 })).toBeNull();
  });

  it('names a rail icon by its tab and its badge', () => {
    expect(L.railLabel('lessons', L.tabBadge('lessons', { read: 2, total: 4 }))).toBe('Lessons, 2 of 4 read');
    expect(L.railLabel('story', null)).toBe('Story');
    expect(L.railLabel('solution', L.tabBadge('solution', { unlocked: false }))).toBe('Solution, locked');
  });
});

describe('the dock', () => {
  it('draws one dot per check: passed, failed, or open before any run', () => {
    expect(L.checkDots([{ pass: true }, { pass: false }, { pass: true }])).toEqual(['p', 'f', 'p']);
    expect(L.checkDots([], 3)).toEqual(['o', 'o', 'o']);
    expect(L.checkDots(undefined, 2)).toEqual(['o', 'o']);
    expect(L.checkDots(null, 0)).toEqual([]);
    // A run wins over the plan, and a plan is capped so a long manifest cannot fill the dock.
    expect(L.checkDots([{ pass: false }], 5)).toEqual(['f']);
    expect(L.checkDots([], 99)).toHaveLength(12);
  });

  it('draws one dot per question: answered first', () => {
    expect(L.answerDots(2, 3)).toEqual(['p', 'p', 'o']);
    expect(L.answerDots(0, 2)).toEqual(['o', 'o']);
    expect(L.answerDots(5, 3)).toEqual(['p', 'p', 'p']);
    expect(L.answerDots(0, 0)).toEqual([]);
  });

  it('names the next hint to come', () => {
    expect(L.hintCountdown({ slots: 0 })).toBe('');
    expect(L.hintCountdown({ slots: 3, locked: [] })).toBe('All 3 hints shown');
    expect(L.hintCountdown({ slots: 1, locked: [] })).toBe('The hint is shown');
    expect(L.hintCountdown({ slots: 3, locked: [12 * 60_000, 40 * 60_000] })).toBe('Next hint in 12 min');
    expect(L.hintCountdown({ slots: 3, locked: [40 * 60_000, 6 * 60_000 + 1] })).toBe('Next hint in 7 min');
    expect(L.hintCountdown({ slots: 2, locked: [30_000] })).toBe('Next hint in under 1 min');
    expect(L.hintCountdown({ slots: 2, locked: [-5] })).toBe('Next hint unlocking now');
    expect(L.hintCountdown({ slots: 2, locked: [65 * 60_000] })).toBe('Next hint in 1 h 5 min');
    expect(L.hintCountdown({ slots: 2, locked: [120 * 60_000] })).toBe('Next hint in 2 h');
    expect(L.hintCountdown({ slots: 2, locked: [null, null] })).toBe('Hints unlock as you go');
  });

  it('runs the checks from a lab graded by checks', () => {
    expect(L.dockAction({ kind: 'checks' })).toEqual({ label: 'Run checks', action: 'checks' });
  });

  it('asks for answers until every question has one, then checks them', () => {
    expect(L.dockAction({ kind: 'answers', answered: 2, total: 3 })).toEqual({ label: 'Answer questions', action: 'questions' });
    expect(L.dockAction({ kind: 'answers', answered: 0, total: 3 })).toEqual({ label: 'Answer questions', action: 'questions' });
    expect(L.dockAction({ kind: 'answers', answered: 3, total: 3 })).toEqual({ label: 'Check my answers', action: 'checks' });
    expect(L.dockAction({ kind: 'answers', answered: 0, total: 0 })).toEqual({ label: 'Check my answers', action: 'checks' });
  });

  it('says how far along the learner is', () => {
    expect(L.dockProgressText({ kind: 'answers', answered: 2, total: 3 })).toBe('2 of 3 answered');
    expect(L.dockProgressText({ kind: 'answers', total: 0 })).toBe('No questions');
    expect(L.dockProgressText({ kind: 'checks', passed: 2, count: 3 })).toBe('2 of 3 checks passing');
    expect(L.dockProgressText({ kind: 'checks', planned: 3 })).toBe('3 checks to pass');
    expect(L.dockProgressText({ kind: 'checks', planned: 1 })).toBe('1 check to pass');
    expect(L.dockProgressText({ kind: 'checks' })).toBe('Checks not run yet');
  });
});

describe('windowTitle', () => {
  it('names the file the Editor has open, else the view', () => {
    expect(L.windowTitle({ view: 'editor', file: 'gateway/config.yaml' })).toBe('gateway/config.yaml');
    expect(L.windowTitle({ view: 'editor' })).toBe('Editor');
    expect(L.windowTitle({ view: 'terminal', file: 'ignored.txt' })).toBe('Terminal');
    expect(L.windowTitle({ view: 'service', service: 'litellm' })).toBe('litellm');
    expect(L.windowTitle({ view: 'service' })).toBe('Service');
  });
});
