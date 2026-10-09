import { createHash } from 'node:crypto';
import { NARRATOR_VOICE, TTS_MODEL, clipKey, narrationLines } from '../../src/labs/comic-kit';

/**
 * The content of the comic specs (18-comic.spec.ts, 19-comic-audio.spec.ts): a small learn bundle and two
 * comics written to the CURRENT contract (a storyteller voiceover per panel, three people on stage: Maren,
 * Tomasz and You; bubbles are text only), and a way to give them the narration `labs narrate` would write,
 * with made-up lengths (every clip the stub serves is the same sample mp3). Nothing here reads a lab, so
 * the specs do not depend on what any lab's story or comic says; test/unit/comic.test.ts checks that these
 * are valid comics and a valid bundle.
 */

export interface FixturePanel {
  scene: string;
  cast: string[];
  bg?: string;
  prop: string;
  caption?: string;
  voiceover?: string;
  bubbles: Array<{ who?: string; text: string; pos?: string }>;
  sfx?: string;
  lines?: string[];
}
export interface FixtureComic {
  title: string;
  pages: Array<{ title?: string; panels: FixturePanel[] }>;
}
export interface FixtureAudio {
  model: string;
  clips: Record<string, { voice: string; text: string; seconds: number; bytes: number }>;
  lines: Array<{ panel: number; kind: string; bubble?: number; clip: string }>;
}
export interface FixtureBundle {
  version: 1;
  story?: { title: string; minutes: number; body: string };
  comic?: FixtureComic;
  audio?: FixtureAudio;
  concepts: Array<{ id: string; title: string; minutes: number; recap: string; body: string }>;
  questions: unknown[];
  answers_file: string;
  fields: Array<{ key: string; prompt: string; kind: string; choices?: string[]; help?: string }>;
  /** A warm-up's closing story (its comic is required) and its games (played after the lessons). */
  closing?: { story: { title: string; minutes: number; body: string }; comic: FixtureComic; audio?: FixtureAudio };
  games?: FixtureGame[];
}
/** One warm-up game as learn/games.yaml compiles it (src/labs/learn.ts GameSchema): the fields of its kind. */
export type FixtureGame = { kind: 'sort' | 'flag' | 'sliders' | 'order-and-nest'; id: string; title: string; prompt: string; explanation: string } & Record<string, unknown>;

export const panelOf = (p: Record<string, unknown>): FixturePanel => ({ cast: [], prop: 'none', bubbles: [], ...p }) as unknown as FixturePanel;

/** Two pages, six panels, five voiced (panel 4, a screen, is silent). */
export const SINGLE: FixtureComic = {
  title: 'Which provider answered?',
  pages: [
    {
      title: 'Tuesday morning',
      panels: [
        panelOf({ scene: 'desk', cast: ['maren'], bg: 'ice', caption: 'Tuesday, a little after ten.', voiceover: 'On Tuesday morning finance asked us which provider had answered a call, and nobody on the team could say.', bubbles: [{ who: 'maren', text: 'Which provider answered, and what did it cost?' }], lines: ['invoice: one line', 'provider: ?'] }),
        panelOf({ scene: 'message', cast: ['tomasz'], bg: 'sand', prop: 'envelope', sfx: 'PING!', voiceover: 'Jonas sent over the invoice, and Priya wrote that support had no idea either.', bubbles: [{ who: 'tomasz', text: 'The gateway should know.' }] }),
        panelOf({ scene: 'portrait', cast: ['you'], bg: 'mint', voiceover: 'You were two days into the job, so Tomasz and I asked you to find out.', bubbles: [{ who: 'you', text: 'I will start with the log.' }] }),
        panelOf({ scene: 'screen', caption: 'A small copy of the system.', lines: ['$ gateway --log', '200 ok support-a', '4xx key expired'] }),
      ],
    },
    {
      title: 'Your turn',
      panels: [
        panelOf({ scene: 'duo', cast: ['maren', 'tomasz'], bg: 'lilac', voiceover: 'Tomasz built the gateway, and I told you where he keeps the log.', bubbles: [{ who: 'maren', text: 'Send it a few calls.' }, { who: 'tomasz', text: 'Then read what it kept.' }] }),
        panelOf({ scene: 'you', bg: 'navy', caption: 'Your turn.', voiceover: 'So now it is your turn: open the log and tell us who answered.', lines: ['$ cat /workspace/answers.json', 'ready.'] }),
      ],
    },
  ],
};

/** Three pages with the whole cast: a titled page of four, an untitled page of three, a closing titled page of two. Nine voiced panels (every one). */
export const MULTI: FixtureComic = {
  title: 'One slow request, no explanation',
  pages: [
    {
      title: 'Tuesday afternoon',
      panels: [
        panelOf({ scene: 'desk', cast: ['tomasz'], bg: 'sand', voiceover: 'Support wrote to us a little after two: one request had taken ages.', bubbles: [{ who: 'tomasz', text: 'This one took ages. Why did the assistant take so long to answer?' }], lines: ['agent: waiting on a reply...', 'waiting...', 'still waiting...'] }),
        panelOf({ scene: 'message', cast: ['maren'], bg: 'lilac', prop: 'envelope', sfx: 'PING!', voiceover: 'Then finance asked what it had cost.', bubbles: [{ who: 'maren', text: 'And what did it cost? I need a number per request.' }] }),
        panelOf({ scene: 'portrait', cast: ['maren'], bg: 'ice', prop: 'chart', sfx: 'HMM.', voiceover: 'I knew we had traced that request from end to end.', bubbles: [{ who: 'maren', text: 'That request was traced end to end. One request, four services, six spans. Read it.' }] }),
        panelOf({ scene: 'duo', cast: ['tomasz', 'you'], bg: 'mint', voiceover: 'Tomasz pointed you to the trace.', bubbles: [{ who: 'tomasz', text: 'The trace is in the lab.' }, { who: 'you', text: 'I will start there.' }] }),
      ],
    },
    {
      panels: [
        panelOf({ scene: 'screen', caption: 'A small copy of the stack, and a trace to read.', voiceover: 'The lab holds a small copy of the stack.', lines: ['$ open jaeger, click Find Traces', '200 1 trace, 4 services, 6 spans', 'slowest span, not the top one: ?', '4xx cache.get missed'] }),
        panelOf({ scene: 'duo', cast: ['maren', 'you'], bg: 'rose', voiceover: 'Maybe the customer could see some of it, I wondered.', bubbles: [{ who: 'maren', text: 'Can customers see any of this?' }, { who: 'you', text: 'Only what we decide to show them.' }] }),
        panelOf({ scene: 'portrait', cast: ['tomasz'], bg: 'navy', prop: 'document', voiceover: 'Tomasz asked you to put it in numbers.', bubbles: [{ who: 'tomasz', text: 'Write down what you find, in numbers.' }] }),
      ],
    },
    {
      title: 'Your turn',
      panels: [
        panelOf({ scene: 'you', bg: 'navy', caption: 'Your turn.', voiceover: 'And that was the whole brief.', lines: ['$ cat /workspace/answers.json', 'ready.'] }),
        panelOf({ scene: 'message', cast: ['maren'], bg: 'sand', prop: 'key', sfx: 'GO!', voiceover: 'The lab is open, so go and have a look.', bubbles: [{ who: 'maren', text: 'The lab is open.' }] }),
      ],
    },
  ],
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The narration `labs narrate` writes for a comic, with a made-up length for each clip (about 2.5 s plus a fourteenth of a second a character). */
export function narrationOf(comic: FixtureComic, bytes = 1000): FixtureAudio {
  const clips: FixtureAudio['clips'] = {};
  const lines = narrationLines(comic as never).map((l) => {
    const key = clipKey(TTS_MODEL, l.voice, l.text, sha);
    clips[key] = { voice: NARRATOR_VOICE, text: l.text, seconds: Math.round((2.5 + l.text.length / 14) * 100) / 100, bytes };
    return { panel: l.panel, kind: l.kind, clip: key };
  });
  return { model: TTS_MODEL, clips, lines };
}

/** The old narration shape (a clip per caption, one voice each, in `caption` and `bubble` lines): a console must play it silent. */
export function oldShapeNarrationOf(comic: FixtureComic): FixtureAudio {
  const clips: FixtureAudio['clips'] = {};
  const lines: FixtureAudio['lines'] = [];
  let panel = 0;
  for (const pg of comic.pages) {
    for (const p of pg.panels) {
      if (p.caption) {
        const key = clipKey(TTS_MODEL, 'atlas', p.caption, sha);
        clips[key] = { voice: 'atlas', text: p.caption, seconds: 2, bytes: 1000 };
        lines.push({ panel, kind: 'caption', clip: key });
      }
      p.bubbles.forEach((b, bubble) => {
        const key = clipKey(TTS_MODEL, 'orion', b.text, sha);
        clips[key] = { voice: 'orion', text: b.text, seconds: 2, bytes: 1000 };
        lines.push({ panel, kind: 'bubble', bubble, clip: key });
      });
      panel += 1;
    }
  }
  return { model: TTS_MODEL, clips, lines };
}

/** A small learn bundle around a comic: the text story, one lesson with its diagnostic question, one field. */
export function bundleOf(comic?: FixtureComic, audio?: FixtureAudio): FixtureBundle {
  return {
    version: 1,
    story: {
      title: 'Monday on the platform team',
      minutes: 2,
      body: 'It is Monday and you have just joined the platform team.\n\nMaren, the platform lead, briefs you. Tomasz, who built the gateway, shows you where its log lives.\n\nYour first job is to find out which provider answered a call.',
    },
    ...(comic ? { comic } : {}),
    ...(audio ? { audio } : {}),
    concepts: [
      {
        id: 'gateway.routing-aliases',
        title: 'Routing aliases',
        minutes: 2,
        recap: 'A routing alias is a stable name that the gateway maps to a real model.',
        body: 'A routing alias is a stable name your code calls. The gateway maps it to a real model, so you can change the model without changing the code.',
      },
    ],
    questions: [
      {
        id: 'q-alias-purpose',
        concept: 'gateway.routing-aliases',
        type: 'single',
        prompt: 'What is a routing alias for?',
        options: [
          { id: 'a', text: 'A stable name that the gateway maps to a real model' },
          { id: 'b', text: 'A password for the provider' },
        ],
        answer: ['a'],
        explanation: 'The alias stays the same while the model behind it can change.',
        diagnostic: true,
      },
    ],
    answers_file: 'answers.json',
    fields: [{ key: 'support_deployment', prompt: 'Which deployment answered support?', kind: 'choice', choices: ['a', 'b'] }],
  };
}

/** The closing comic of the warm-up fixture: four panels (the fewest a comic may have), every one voiced. */
export const CLOSING: FixtureComic = {
  title: 'What we found',
  pages: [
    {
      panels: [
        panelOf({ scene: 'desk', cast: ['maren'], bg: 'ice', voiceover: 'By Friday we knew which provider had answered.', bubbles: [{ who: 'maren', text: 'So that was it.' }] }),
        panelOf({ scene: 'portrait', cast: ['tomasz'], bg: 'sand', voiceover: 'The alias had moved and nobody had noticed.' }),
        panelOf({ scene: 'screen', voiceover: 'Here is the line that told us.', lines: ['alias: fast = provider-b'] }),
        panelOf({ scene: 'you', bg: 'navy', voiceover: 'Now you know where to look.', lines: ['$ go'] }),
      ],
    },
  ],
};

/** One small game of each kind, valid to the schema; the warm-up spec plays them in this order. */
export const GAMES: FixtureGame[] = [
  {
    kind: 'sort',
    id: 'sort-calls',
    title: 'Who pays?',
    prompt: 'Put each call where its cost lands.',
    explanation: 'The gateway bills the team that owns the key.',
    buckets: [
      { id: 'team', label: 'The team' },
      { id: 'platform', label: 'The platform' },
    ],
    cards: [
      { id: 'c1', text: 'A call with the team key', bucket: 'team' },
      { id: 'c2', text: 'A health check', bucket: 'platform' },
      { id: 'c3', text: 'A retry of a team call', bucket: 'team' },
    ],
  },
  {
    kind: 'flag',
    id: 'flag-logs',
    title: 'Spot the leak',
    prompt: 'Flag the log lines that leak a secret.',
    explanation: 'Keys never belong in logs.',
    items: [
      { id: 'a', text: 'key=sk-123', flag: true, why: 'A raw key.' },
      { id: 'b', text: 'status=200', flag: false },
      { id: 'c', text: 'model=fast', flag: false },
    ],
  },
  {
    kind: 'sliders',
    id: 'cost',
    title: 'What a day costs',
    prompt: 'Move the sliders and watch the bill.',
    explanation: 'Calls times price is the bill.',
    inputs: [
      { id: 'calls', label: 'Calls a day', min: 0, max: 1000, step: 10, default: 100 },
      { id: 'price', label: 'Price per call', min: 0, max: 1, step: 0.01, default: 0.1, unit: 'USD' },
    ],
    formula: [
      { input: 'calls', op: '*' },
      { input: 'price', op: '*' },
    ],
    readout: { label: 'Daily cost', unit: 'USD', decimals: 2 },
    ask: { prompt: 'Which input moves the bill most?', answer: 'calls' },
  },
  {
    kind: 'order-and-nest',
    id: 'request-path',
    title: 'Follow one request',
    prompt: 'Order the steps and nest them.',
    explanation: 'The gateway wraps the provider call.',
    steps: [
      { id: 'gw', text: 'Gateway receives the call', parent: null, order: 0 },
      { id: 'alias', text: 'Alias resolves', parent: 'gw', order: 0 },
      { id: 'provider', text: 'Provider answers', parent: 'gw', order: 1 },
    ],
  },
];

/**
 * A warm-up's bundle (the 26-warm-up spec): the small bundle above, with no fields (a lab with games has
 * none), its closing story and comic, and one game of each kind.
 */
export function warmUpBundleOf(comic?: FixtureComic): FixtureBundle {
  return {
    ...bundleOf(comic),
    fields: [],
    closing: {
      story: { title: 'Friday on the platform team', minutes: 1, body: 'By Friday you knew which provider had answered, and why.' },
      comic: CLOSING,
    },
    games: GAMES,
  };
}
