import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeDom, press, fakeClock, type FakeDocument, type FakeElement } from '../fakes/fake-dom';

/**
 * The warm-up games mounted (dashboard/src/games.js) on a small fake DOM (test/fakes/fake-dom.ts) and
 * played from the keyboard: Start, the cards with ← and →, a wrong card's heart and Next, the clock running
 * out on a hand-moved clock, the pipeline with Space and the arrows, the sliders' answer, the end screen's
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
  prompt: 'Order the steps.',
  explanation: 'The call holds every step.',
  steps: [
    { id: 'gw', text: 'Gateway', parent: null, order: 0 },
    { id: 'alias', text: 'Alias', parent: 'gw', order: 0 },
    { id: 'provider', text: 'Provider', parent: 'gw', order: 1 },
  ],
};
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

  it('a host the game does not name, or one not of the cast, is Tomasz', () => {
    const { root } = mount({ ...sortGame, host: 'nobody' });
    expect(q(root, '.game-host-name').textContent).toBe('Tomasz');
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

describe('order-and-nest, played from the keyboard', () => {
  const order = (root: FakeElement) => root.querySelectorAll('.game-tile').map((t) => `${t.dataset.id}:${t.dataset.depth}`);
  /** Moves the tile `id` to row `to` at `depth` with Space, the arrows and Space. */
  function place(root: FakeElement, id: string, to: number, depth: number) {
    const tile = q(root, `.game-tile[data-id="${id}"]`);
    tile.focus();
    press(doc, ' ');
    expect(tile.dataset.grabbed).toBe('true');
    for (let guard = 0; guard < 6; guard++) {
      const at = order(root).findIndex((s) => s.startsWith(`${id}:`));
      if (at === to) break;
      press(doc, at > to ? 'ArrowUp' : 'ArrowDown');
    }
    for (let guard = 0; guard < 4 && Number(tile.dataset.depth) !== depth; guard++) press(doc, Number(tile.dataset.depth) < depth ? 'ArrowRight' : 'ArrowLeft');
    press(doc, ' ');
    expect(tile.dataset.grabbed).toBeUndefined();
  }

  it('a wrong send bounces at the first wrong step; then Space and the arrows put it right and it goes through', () => {
    const { root, results } = mount(pipeGame);
    start(root);
    expect(order(root)).toHaveLength(3);
    expect(q(root, '.game-lives').hidden).toBe(true);
    // Sent as shuffled (never already right): it stops at a wrong step.
    q(root, '.game-send').click();
    const wrong = root.querySelectorAll('.game-tile[data-state="wrong"]');
    expect(wrong).toHaveLength(1);
    expect(q(root, '.game-status').textContent).toContain('Bounced');
    expect(results).toEqual([]);
    place(root, 'gw', 0, 0);
    place(root, 'alias', 1, 1);
    place(root, 'provider', 2, 1);
    expect(order(root)).toEqual(['gw:0', 'alias:1', 'provider:1']);
    q(root, '.game-send').click();
    expect(root.dataset.phase).toBe('end');
    expect(q(root, '.game-stars').getAttribute('aria-label')).toBe('2 of 3 stars');
    expect(Number(q(root, '.game-end-points').textContent)).toBe(750);
    expect(root.querySelectorAll('.game-recap-step').map((s) => s.textContent)).toEqual(['Gateway', 'Alias', 'Provider']);
    expect(results).toEqual([{ id: 'through-the-door', solved: true, tries: 1 }]);
  });

  it('Escape puts a picked-up step back where it was; ↑ and ↓ move the focus when nothing is held', () => {
    const { root } = mount(pipeGame);
    start(root);
    const before = order(root);
    const first = q(root, '.game-tile');
    first.focus();
    press(doc, ' ');
    press(doc, 'ArrowDown');
    expect(order(root)).not.toEqual(before);
    press(doc, 'Escape');
    expect(order(root)).toEqual(before);
    press(doc, 'ArrowDown');
    expect(doc.activeElement).toBe(root.querySelectorAll('.game-tile')[1]);
  });

  it("a tile's buttons move it too", () => {
    const { root } = mount(pipeGame);
    start(root);
    const second = root.querySelectorAll('.game-tile')[1]!;
    const id = second.dataset.id;
    q(second, '[data-action="up"]').click();
    expect(root.querySelectorAll('.game-tile')[0]!.dataset.id).toBe(id);
    expect(q(root.querySelectorAll('.game-tile')[0]!, '[data-action="up"]').disabled).toBe(true);
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
