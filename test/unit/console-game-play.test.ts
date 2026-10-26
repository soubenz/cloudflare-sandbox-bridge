import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeDom, press, fakeClock, type FakeDocument, type FakeElement } from '../fakes/fake-dom';

/**
 * The warm-up games mounted (dashboard/src/games.js) on a small fake DOM (test/fakes/fake-dom.ts) and
 * played from the keyboard: Start, the cards with ← and →, a wrong card's heart and Next, the clock running
 * out on a hand-moved clock, "what happens next" with taps and the number keys, the sliders' answer, the end screen's
 * stars, recap, best score, Play again and Continue, and Skip.
 */
type Game = Record<string, any>;
const G = (await import('../../dashboard/src/games.js' as string)) as { mountGame: (host: any, game: Game, opts?: Record<string, any>) => { root: FakeElement; destroy: () => void } };

const sortGame: Game = {
  id: 'whose-key',
  kind: 'sort',
  title: 'Whose key is it?',
  prompt: 'Who holds the key?',
  explanation: 'Behind a gateway only the gateway holds keys.',
  host: 'maren',
  buckets: [
    { id: 'app', label: 'The app' },
    { id: 'gateway', label: 'The gateway' },
  ],
  cards: [
    { id: 'c1', text: 'Direct call', bucket: 'app', why: 'A direct call carries the key.' },
    { id: 'c2', text: 'Alias call', bucket: 'gateway' },
    { id: 'c3', text: 'Settings file', bucket: 'app' },
  ],
};
const flagGame: Game = {
  id: 'provider-down',
  kind: 'flag',
  title: 'Provider down',
  prompt: 'Which keep answering?',
  explanation: 'A second provider keeps it answering.',
  choices: { flag: 'Keeps answering', leave: 'Goes dark' },
  board: [
    { name: 'OpenAI', status: 'down' },
    { name: 'Anthropic', status: 'up' },
  ],
  items: [
    { id: 'a', text: 'Two providers', flag: true },
    { id: 'b', text: 'One provider', flag: false, why: 'Nothing else is set up.' },
    { id: 'c', text: 'Retry only', flag: false },
  ],
};
const pipeGame: Game = {
  id: 'through-the-door',
  kind: 'order-and-nest',
  title: 'Through the door',
  prompt: 'What happens to one call?',
  explanation: 'The call holds every step.',
  // Depth first: gw, alias, cache (under alias), provider.
  steps: [
    { id: 'provider', text: 'The gateway calls the provider', parent: 'gw', order: 1, why: 'The provider is called last.' },
    { id: 'alias', text: 'The gateway looks the alias up', parent: 'gw', order: 0 },
    { id: 'gw', text: 'The app sends a call', parent: null, order: 0 },
    { id: 'cache', text: 'The gateway checks its cache', parent: 'alias', order: 0 },
  ],
};
const ROUTE = ['gw', 'alias', 'cache', 'provider'];
const sliderGame: Game = {
  id: 'cost',
  kind: 'sliders',
  title: 'Cost',
  prompt: 'Move them.',
  explanation: 'Calls times price.',
  inputs: [
    { id: 'calls', label: 'Calls', min: 0, max: 100, step: 1, default: 10 },
    { id: 'price', label: 'Price', min: 0, max: 1, step: 0.1, default: 0.5 },
  ],
  formula: [
    { input: 'calls', op: '*' },
    { input: 'price', op: '*' },
  ],
  readout: { label: 'Cost', unit: 'USD', decimals: 2 },
  ask: { prompt: 'Which moves it most?', answer: 'calls' },
};

let dom: ReturnType<typeof installFakeDom>;
let doc: FakeDocument;
let host: FakeElement;
beforeEach(() => {
  dom = installFakeDom();
  doc = dom.document;
  host = doc.createElement('div');
  doc.body.append(host);
});
afterEach(() => dom.restore());

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

function mount(game: Game, opts: Record<string, any> = {}) {
  const results: any[] = [];
  const calls: string[] = [];
  const storage = opts.storage ?? memory();
  const g = G.mountGame(host, game, {
    testMode: true,
    storage,
    seed: 5,
    onResult: (r: any) => results.push(r),
    onContinue: () => calls.push('continue'),
    onSkip: () => calls.push('skip'),
    ...opts,
  });
  return { g, root: g.root, results, calls, storage };
}

const q = (root: FakeElement, sel: string) => root.querySelector(sel)!;
const start = (root: FakeElement) => q(root, '.game-start').click();
const currentCard = (root: FakeElement) => q(root, '.game-cardx').dataset.card;
const answerOf = (game: Game, id: string) => (game.kind === 'flag' ? (game.items.find((i: any) => i.id === id).flag ? 'flag' : 'leave') : game.cards.find((c: any) => c.id === id).bucket);
const keyFor = (game: Game, choice: string) => {
  const ids = game.kind === 'flag' ? ['leave', 'flag'] : game.buckets.map((b: any) => b.id);
  return ids.indexOf(choice) === 0 ? 'ArrowLeft' : 'ArrowRight';
};

describe('the shell', () => {
  it('opens on the title, the goal, the host, the rules and Start; Skip is there before Start', () => {
    const { root, calls } = mount(sortGame);
    expect(root.dataset.phase).toBe('intro');
    expect(q(root, '.game-title').textContent).toBe('Whose key is it?');
    expect(q(root, '.game-prompt').textContent).toBe('Who holds the key?');
    expect(q(root, '.game-host-name').textContent).toBe('Maren');
    expect(q(root, '.game-host-art').innerHTML).toContain('data-cast="maren"');
    expect(root.querySelectorAll('.game-rules li').length).toBeGreaterThan(1);
    expect(q(root, '.game-stage').hidden).toBe(true);
    expect(root.dataset.still).toBe('');
    expect(q(root, '#btnSkipAllGames')).toBeNull();
    q(root, '#btnSkipGame').click();
    expect(calls).toEqual(['skip']);
  });

  it('a host the game does not name, or one not of the cast, is Tomas', () => {
    const { root } = mount({ ...sortGame, host: 'nobody' });
    expect(q(root, '.game-host-name').textContent).toBe('Tomas');
  });

  it('says a game it does not know is not available', () => {
    const { root } = mount({ ...sortGame, kind: 'mystery' });
    expect(root.textContent).toContain('not available');
  });

  it('shows Skipped or Solved when the learner skipped or solved it before', () => {
    expect(q(mount(sortGame, { previous: 'skipped' }).root, '.game-badge').textContent).toBe('Skipped');
    host.replaceChildren();
    expect(q(mount(sortGame, { previous: 'solved' }).root, '.game-badge').textContent).toBe('Solved');
  });

  it('Skip all games is offered when asked for, and skips without asking', () => {
    const calls: string[] = [];
    const { root } = mount(sortGame, { onSkipAll: () => calls.push('all') });
    start(root);
    q(root, '#btnSkipAllGames').click();
    expect(calls).toEqual(['all']);
  });
});

describe('sort, played from the keyboard', () => {
  it('Start deals a card that takes focus; ← and → answer; a perfect round has 3 stars and reports one try', () => {
    const { root, results, calls, storage } = mount(sortGame);
    start(root);
    expect(root.dataset.phase).toBe('play');
    expect(doc.activeElement).toBe(q(root, '.game-cardx'));
    expect(q(root, '.game-lives').getAttribute('aria-label')).toBe('3 of 3 hearts left');
    expect(root.querySelectorAll('.game-bucket').map((b) => b.textContent)).toEqual(['←The app', '→The gateway']);
    for (let i = 0; i < 3; i++) press(doc, keyFor(sortGame, answerOf(sortGame, currentCard(root)!)));
    expect(root.dataset.phase).toBe('end');
    expect(q(root, '.game-end-title').textContent).toBe('Perfect round!');
    expect(doc.activeElement).toBe(q(root, '.game-end-title'));
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('3 of 3 stars');
    expect(Number(q(root, '.game-end-points').textContent)).toBe(100 + 125 + 150);
    expect(q(root, '.game-newbest')).not.toBeNull();
    expect(storage.m.get('opalix.gameBest')).toContain('375');
    // The recap: every card with its right answer and why.
    const recap = root.querySelectorAll('.game-recap-item');
    expect(recap).toHaveLength(3);
    expect(recap[0]!.textContent).toContain('Direct call');
    expect(recap[0]!.textContent).toContain('→ The app');
    expect(recap[0]!.textContent).toContain('A direct call carries the key.');
    expect(q(root, '.game-explain-body').textContent).toBe(sortGame.explanation);
    expect(results).toEqual([{ id: 'whose-key', solved: true, tries: 1 }]);
    // Won: no skipping any more; Continue is there.
    expect(q(root, '.game-skipbar').hidden).toBe(true);
    q(root, '.game-continue').click();
    expect(calls).toEqual(['continue']);
  });

  it('← and → still answer when the focus has left the game (it is on the page itself)', () => {
    const { root, results } = mount(sortGame);
    start(root);
    for (let i = 0; i < 3; i++) {
      doc.activeElement = doc.body;
      press(doc, keyFor(sortGame, answerOf(sortGame, currentCard(root)!)));
    }
    expect(root.dataset.phase).toBe('end');
    expect(results).toEqual([{ id: 'whose-key', solved: true, tries: 1 }]);
  });

  it('tapping a bucket answers too', () => {
    const { root, results } = mount(sortGame);
    start(root);
    for (let i = 0; i < 3; i++) q(root, `.game-bucket[data-bucket="${answerOf(sortGame, currentCard(root)!)}"]`).click();
    expect(results).toHaveLength(1);
  });

  it('a wrong card costs a heart, shows the answer and why, waits for Next, and comes back later', () => {
    const { root, results } = mount(sortGame);
    start(root);
    const first = currentCard(root)!;
    const right = answerOf(sortGame, first);
    press(doc, right === 'app' ? 'ArrowRight' : 'ArrowLeft');
    expect(q(root, '.game-lives').getAttribute('aria-label')).toBe('2 of 3 hearts left');
    expect(q(root, '.game-cardx').dataset.result).toBe('wrong');
    expect(q(root, `.game-bucket[data-bucket="${right}"]`).dataset.flash).toBe('answer');
    expect(q(root, '.game-bubble').hidden).toBe(false);
    expect(q(root, '.game-bubble').dataset.empty).toBeUndefined();
    expect(q(root, '.game-bubble').textContent).toContain('Not quite.');
    expect(q(root, '.game-host').dataset.mood).toBe('worried');
    expect(q(root, '.game-status').textContent).toContain('Not quite');
    const next = q(root, '.game-next');
    expect(next.hidden).toBe(false);
    expect(doc.activeElement).toBe(next);
    // While waiting, the arrows do nothing.
    press(doc, 'ArrowLeft', q(root, '.game-cardx'));
    expect(q(root, '.game-lives').getAttribute('aria-label')).toBe('2 of 3 hearts left');
    next.click();
    expect(currentCard(root)).not.toBe(first);
    // Clear the deck: the missed card comes back last.
    const seen: string[] = [];
    while (root.dataset.phase === 'play') {
      const id = currentCard(root)!;
      seen.push(id);
      press(doc, keyFor(sortGame, answerOf(sortGame, id)));
    }
    expect(seen[seen.length - 1]).toBe(first);
    expect(q(root, '.game-end-title').textContent).toBe('Round cleared!');
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('2 of 3 stars');
    expect(results).toEqual([{ id: 'whose-key', solved: true, tries: 1 }]);
  });

  it('three hearts lost is game over: no result, Try again starts a new round that counts as the second try', () => {
    const { root, results } = mount(sortGame);
    start(root);
    for (let i = 0; i < 3; i++) {
      const id = currentCard(root)!;
      press(doc, answerOf(sortGame, id) === 'app' ? 'ArrowRight' : 'ArrowLeft');
      q(root, '.game-next').click();
    }
    expect(root.dataset.phase).toBe('end');
    expect(q(root, '.game-end-title').textContent).toBe('Out of hearts');
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('0 of 3 stars');
    expect(results).toEqual([]);
    expect(q(root, '.game-continue')).toBeNull();
    expect(q(root, '.game-skipbar').hidden).toBe(false);
    q(root, '.game-again').click();
    expect(root.dataset.phase).toBe('play');
    for (let i = 0; i < 3; i++) press(doc, keyFor(sortGame, answerOf(sortGame, currentCard(root)!)));
    expect(results).toEqual([{ id: 'whose-key', solved: true, tries: 2 }]);
  });
});

/** The count-in: 3, 2 and 1 at 650 ms each, then Go! for 350 ms. */
const COUNT_IN = 3 * 650 + 350;

describe('the clock', () => {
  it('counts in 3, 2, 1, then each card drains its timer; running out costs a heart', () => {
    const clock = fakeClock();
    const { root } = mount({ ...sortGame, timer: 5 }, { testMode: false, reducedMotion: true, clock, storage: memory() });
    start(root);
    expect(root.dataset.phase).toBe('count');
    expect(q(root, '.game-count').textContent).toBe('3');
    clock.tick(COUNT_IN);
    expect(root.dataset.phase).toBe('play');
    expect(q(root, '.game-clock').hidden).toBe(false);
    expect(q(root, '.game-clock-num').textContent).toBe('5');
    clock.tick(2100);
    expect(q(root, '.game-clock-num').textContent).toBe('3');
    expect(q(root, '.game-clock').dataset.low).toBe('true');
    clock.tick(3000);
    expect(q(root, '.game-lives').getAttribute('aria-label')).toBe('2 of 3 hearts left');
    expect(q(root, '.game-status').textContent).toContain('Time is up');
    expect(q(root, '.game-host').dataset.mood).toBe('surprised');
  });

  it('the Timer toggle turns the clock off (remembered), and a fast answer earns the speed bonus', () => {
    const clock = fakeClock();
    const storage = memory();
    const { root } = mount({ ...sortGame, timer: 8 }, { testMode: false, reducedMotion: true, clock, storage });
    start(root);
    clock.tick(COUNT_IN);
    press(doc, keyFor(sortGame, answerOf(sortGame, currentCard(root)!)));
    expect(Number(q(root, '.game-score-value').textContent)).toBe(150);
    clock.tick(1000);
    const toggle = q(root, '.game-timer-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(storage.m.get('opalix.gameTimer')).toBe('0');
    expect(q(root, '.game-clock').hidden).toBe(true);
    clock.tick(60_000);
    expect(q(root, '.game-lives').getAttribute('aria-label')).toBe('3 of 3 hearts left');
  });

  it('the Sound toggle writes the comic sound preference', () => {
    const storage = memory();
    const { root } = mount(sortGame, { storage });
    const sound = q(root, '.game-sound');
    const before = sound.getAttribute('aria-pressed');
    sound.click();
    expect(sound.getAttribute('aria-pressed')).not.toBe(before);
    expect(storage.m.get('opalix.comicSound')).toBe(before === 'true' ? '0' : '1');
  });
});

describe('flag', () => {
  it('shows the live board and the two sides in the words of `choices`; → flags, ← leaves', () => {
    const { root, results } = mount(flagGame);
    const board = root.querySelectorAll('.game-board-item');
    expect(board.map((b) => [b.dataset.status, b.textContent])).toEqual([
      ['down', 'OpenAIDown'],
      ['up', 'AnthropicUp'],
    ]);
    start(root);
    expect(q(root, '.game-bucket[data-side="left"]').textContent).toContain('Goes dark');
    expect(q(root, '.game-bucket[data-side="right"]').textContent).toContain('Keeps answering');
    for (let i = 0; i < 3; i++) press(doc, answerOf(flagGame, currentCard(root)!) === 'flag' ? 'ArrowRight' : 'ArrowLeft');
    expect(results).toEqual([{ id: 'provider-down', solved: true, tries: 1 }]);
    expect(root.querySelectorAll('.game-recap-item')[1]!.textContent).toContain('Nothing else is set up.');
  });
});

describe('order-and-nest: what happens next', () => {
  const pool = (root: FakeElement) => root.querySelectorAll('.game-route-card').map((c) => c.dataset.id);
  const card = (root: FakeElement, id: string) => q(root, `.game-route-card[data-id="${id}"]`);
  const filled = (root: FakeElement) => root.querySelectorAll('.game-route-slot[data-filled="true"]').map((s) => s.textContent);
  const status = (root: FakeElement) => q(root, '.game-status').textContent;
  const hearts = (root: FakeElement) => q(root, '.game-lives').getAttribute('aria-label');

  it('asks what happens first, with every step a numbered card, the route strip empty and three hearts', () => {
    const { root } = mount(pipeGame);
    expect(root.querySelectorAll('.game-rules li').map((l) => l.textContent).join(' ')).toMatch(/happens first/);
    start(root);
    expect(q(root, '.game-route-ask').textContent).toBe('What happens first?');
    expect([...pool(root)].sort()).toEqual([...ROUTE].sort());
    expect(pool(root)).not.toEqual(ROUTE);
    expect(root.querySelectorAll('.game-route-card').map((c) => q(c, '.game-route-key').textContent)).toEqual(['1', '2', '3', '4']);
    expect(root.querySelectorAll('.game-route-card').every((c) => c.tagName === 'BUTTON')).toBe(true);
    expect(root.querySelectorAll('.game-route-slot')).toHaveLength(4);
    expect(filled(root)).toEqual([]);
    expect(hearts(root)).toBe('3 of 3 hearts left');
    expect(q(root, '.game-streak').hidden).toBe(false);
    // The focus is on the first card of the pool. None of the old pipeline is drawn.
    expect(doc.activeElement).toBe(root.querySelectorAll('.game-route-card')[0]);
    expect(root.querySelectorAll('.game-tile, .game-send, .game-pipeline')).toHaveLength(0);
  });

  it('tapping each step in turn fills the route, moves the packet, scores with a combo, and wins with 3 stars', () => {
    const { root, results, calls } = mount(pipeGame);
    start(root);
    for (const [i, id] of ROUTE.entries()) {
      card(root, id).click();
      if (i < ROUTE.length - 1) {
        expect(status(root)).toContain(`Right: step ${i + 1} of 4`);
        expect(q(root, '.game-route-ask').textContent).toBe('What happens next?');
        expect(pool(root)).not.toContain(id);
        // The packet rides on the newest slot; the focus stays in the pool.
        expect(q(root, `.game-route-slot[data-n="${i + 1}"] .game-route-packet`)).not.toBeNull();
        expect(doc.activeElement).toBe(root.querySelectorAll('.game-route-card')[0]);
      }
    }
    expect(q(root, '.game-combo').textContent).toBe('×1.75');
    expect(root.dataset.phase).toBe('end');
    expect(q(root, '.game-end-title').textContent).toBe('Straight through!');
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('3 of 3 stars');
    // 100, 125, 150, 175: the card games' combo, no clock in test mode.
    expect(Number(q(root, '.game-end-points').textContent)).toBe(550);
    // The answer: the whole route, 1 to N, and the explanation.
    expect(root.querySelectorAll('.game-route-answer-step').map((s) => s.textContent)).toEqual([
      'The app sends a call',
      'The gateway looks the alias up',
      'The gateway checks its cache',
      'The gateway calls the provider',
    ]);
    expect(q(root, '.game-explain-body').textContent).toBe('The call holds every step.');
    expect(results).toEqual([{ id: 'through-the-door', solved: true, tries: 1 }]);
    q(root, '.game-continue').click();
    expect(calls).toEqual(['continue']);
  });

  it('a wrong tap costs a heart, the host says what comes first, and the card stays in the pool', () => {
    const { root, results } = mount(pipeGame);
    start(root);
    card(root, 'gw').click();
    card(root, 'cache').click();
    expect(hearts(root)).toBe('2 of 3 hearts left');
    expect(q(root, '.game-host').dataset.mood).toBe('worried');
    expect(q(root, '.game-bubble').textContent).toBe('Not yet. First: The gateway looks the alias up.');
    expect(status(root)).toBe('Not yet. First: The gateway looks the alias up. 2 hearts left.');
    expect(card(root, 'cache').dataset.result).toBe('wrong');
    expect(pool(root)).toContain('cache');
    expect(filled(root)).toHaveLength(1);
    expect(q(root, '.game-combo').textContent).toBe('×1');
    expect(doc.activeElement).toBe(root.querySelectorAll('.game-route-card')[0]);
    // A step with its own `why` says that instead.
    card(root, 'provider').click();
    expect(q(root, '.game-bubble').textContent).toBe('Not yet. The provider is called last.');
    // Then the rest in order: won with two mistakes, 1 star, the missed step marked in the route.
    for (const id of ROUTE.slice(1)) card(root, id).click();
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('1 of 3 stars');
    expect(q(root, '.game-end-title').textContent).toBe('Route complete!');
    expect(root.querySelectorAll('.game-route-answer-step').map((s) => s.dataset.ok)).toEqual(['true', 'false', 'true', 'true']);
    expect(results).toEqual([{ id: 'through-the-door', solved: true, tries: 1 }]);
  });

  it('keys 1 to 9 pick the card with that number', () => {
    const { root } = mount(pipeGame);
    start(root);
    const numberOf = (id: string) => String(pool(root).indexOf(id) + 1);
    for (const id of ROUTE) press(doc, numberOf(id));
    expect(root.dataset.phase).toBe('end');
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('3 of 3 stars');
  });

  it('a number with no card does nothing; the keys work with the focus on the page', () => {
    const { root } = mount(pipeGame);
    start(root);
    press(doc, '9');
    expect(hearts(root)).toBe('3 of 3 hearts left');
    press(doc, String(pool(root).indexOf('gw') + 1), doc.body);
    expect(filled(root)).toHaveLength(1);
  });

  it('three wrong taps end the round: the whole route shown, Try again plays a new round', () => {
    const { root, results } = mount(pipeGame);
    start(root);
    for (let i = 0; i < 3; i++) card(root, 'provider').click();
    expect(root.dataset.phase).toBe('end');
    expect(q(root, '.game-end-title').textContent).toBe('Out of hearts');
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('0 of 3 stars');
    expect(root.querySelectorAll('.game-route-answer-step')).toHaveLength(4);
    expect(root.querySelectorAll('.game-route-answer-step').map((s) => s.textContent.replace(/^.*\(/, '('))).toEqual(['(missed 3 times)', '(not reached)', '(not reached)', '(not reached)']);
    expect(q(root, '.game-continue')).toBeNull();
    expect(results).toEqual([]);
    const again = q(root, '.game-again');
    expect(again.textContent).toBe('Try again');
    again.click();
    expect(root.dataset.phase).toBe('play');
    expect(hearts(root)).toBe('3 of 3 hearts left');
    expect(filled(root)).toEqual([]);
    for (const id of ROUTE) card(root, id).click();
    expect(results).toEqual([{ id: 'through-the-door', solved: true, tries: 2 }]);
  });

  it('with the clock on, each step has its timer; running out costs a heart and names the step', () => {
    const clock = fakeClock();
    const { root } = mount({ ...pipeGame, timer: 5 }, { testMode: false, reducedMotion: true, clock, storage: memory() });
    start(root);
    clock.tick(COUNT_IN);
    expect(q(root, '.game-route-clock').hidden).toBe(false);
    expect(q(root, '.game-clock-num').textContent).toBe('5');
    clock.tick(5100);
    expect(hearts(root)).toBe('2 of 3 hearts left');
    expect(q(root, '.game-bubble').textContent).toBe('Time is up. First: The app sends a call.');
    // A fresh clock for the same step; a right tap under reduced motion places it after a short pop.
    expect(q(root, '.game-clock-num').textContent).toBe('5');
    card(root, 'gw').click();
    expect(filled(root)).toHaveLength(1);
    clock.tick(300);
    expect(q(root, '.game-route-ask').textContent).toBe('What happens next?');
    expect(pool(root)).not.toContain('gw');
  });
});

describe('sliders', () => {
  it('a wrong slider shakes and is struck off; the right one ends the game', () => {
    const { root, results } = mount(sliderGame);
    start(root);
    expect(doc.activeElement).toBe(q(root, '.game-range'));
    expect(q(root, '.game-readout-value').textContent).toBe('5.00 USD');
    q(root, '.game-ask-option[data-option="price"]').click();
    expect(q(root, '.game-ask-option[data-option="price"]').disabled).toBe(true);
    expect(q(root, '.game-host').dataset.mood).toBe('worried');
    expect(results).toEqual([]);
    q(root, '.game-ask-option[data-option="calls"]').click();
    expect(root.dataset.phase).toBe('end');
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('2 of 3 stars');
    expect(Number(q(root, '.game-end-points').textContent)).toBe(750);
    expect(results).toEqual([{ id: 'cost', solved: true, tries: 1 }]);
  });

  it('with a target, the meter says how close the readout is', () => {
    const { root } = mount({ ...sliderGame, target: { value: 5, tolerance: 0 } });
    start(root);
    expect(q(root, '.game-meter').hidden).toBe(false);
    expect(q(root, '.game-meter-text').textContent).toContain('100% there');
    q(root, '.game-ask-option[data-option="calls"]').click();
    expect(Number(q(root, '.game-end-points').textContent)).toBe(1000);
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('3 of 3 stars');
  });
});
