import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../src/env';
import { audioKey, currentKey } from '../../src/labs/bundle';
import { TTS_MODEL, clipKey, legacyNarrationLines, narrationLines } from '../../src/labs/comic-kit';
import { parseByteRange } from '../../src/lib/range';

/**
 * The narration clips through the real router: `labs publish` uploads them beside the learn bundle
 * (validated against the bundle's audio index), the Worker stores them in R2, and
 * GET /labs/:slug/audio/:file serves them to the console Worker (service key) with Range support.
 */

const pool = vi.hoisted(() => ({ admit: vi.fn(async () => {}), stats: vi.fn() }));
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));
const { createRouter } = await import('../../src/router');
const app = createRouter();

const SERVICE = { Authorization: 'Bearer svc-key' };
const MP3 = new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'audio', 'maren-thalia.mp3')));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** In-memory R2 holding bytes, with the surface the routes use (head size, ranged get, list, delete). */
function fakeBucket() {
  const store = new Map<string, { bytes: Uint8Array; type?: string }>();
  const toBytes = (v: unknown): Uint8Array => (typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer));
  const bucket = {
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      const v = store.get(key);
      if (!v) return null;
      const bytes = opts?.range ? v.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : v.bytes;
      return { body: new Blob([bytes]).stream(), size: v.bytes.length, text: async () => new TextDecoder().decode(v.bytes), json: async () => JSON.parse(new TextDecoder().decode(v.bytes)) };
    },
    async head(key: string) {
      const v = store.get(key);
      return v ? { key, size: v.bytes.length } : null;
    },
    async put(key: string, value: unknown, o?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { bytes: toBytes(value), type: o?.httpMetadata?.contentType });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(o: { prefix?: string } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(o.prefix ?? '')).sort().map((key) => ({ key })), truncated: false };
    },
  };
  return { bucket, store };
}

function makeEnv() {
  const { bucket, store } = fakeBucket();
  const env = { SANDBOX_API_KEY: 'svc-key', SESSION_TOKEN_SECRET: 'secret', PUBLIC_BASE_URL: 'https://api.test', DB: {}, LABS_BUCKET: bucket } as unknown as Env;
  return { env, store };
}

const call = (env: Env, method: string, path: string, opts: { body?: BodyInit; headers?: Record<string, string> } = {}) =>
  app.fetch(new Request(`https://api.test${path}`, { method, headers: opts.headers, body: opts.body }), env);

const panel = (p: Record<string, unknown>) => ({ scene: 'desk', cast: [], prop: 'none', bubbles: [], ...p });
const COMIC = {
  title: 'Which provider answered?',
  pages: [
    {
      panels: [
        panel({ cast: ['maren'], caption: 'Tuesday.', voiceover: 'On Tuesday finance had a question.', bubbles: [{ who: 'maren', text: 'Which provider answered?' }], lines: ['x'] }),
        panel({ scene: 'portrait', cast: ['tomasz'], voiceover: 'Tomasz knew where to look.', bubbles: [{ who: 'tomasz', text: 'Find out.' }] }),
        panel({ scene: 'screen', caption: 'A copy.', voiceover: 'We made a small copy of it.', lines: ['$ run', 'ok'] }),
        panel({ scene: 'you', caption: 'Your turn.', voiceover: 'Now it is your turn.', lines: ['$ go'] }),
      ],
    },
  ],
};

/** A learn bundle with the narration of COMIC; every clip is the sample mp3 (as long as `bytes`). */
function learn(opts: { bytes?: number } = {}) {
  const clips: Record<string, unknown> = {};
  const lines = narrationLines(COMIC as any).map((l) => {
    const key = clipKey(TTS_MODEL, l.voice, l.text, sha);
    clips[key] = { voice: l.voice, text: l.text, seconds: 2, bytes: opts.bytes ?? MP3.length };
    return { panel: l.panel, kind: l.kind, clip: key };
  });
  return {
    version: 1,
    story: { title: 'Monday', minutes: 2, body: 'You start on Monday.' },
    comic: COMIC,
    audio: { model: TTS_MODEL, clips, lines },
    concepts: [],
    questions: [],
    fields: [{ key: 'a', prompt: 'p', kind: 'text' }],
  };
}
const keysOf = (b: ReturnType<typeof learn>) => Object.keys(b.audio.clips);

function manifest(slug: string) {
  return { slug, version: '1.0.0', title: `Lab ${slug}`, type: 'explore', family: 'agent', timeout_minutes: 60, services: [{ name: 'svc', argv: ['x'], port: 8000 }], checks: [{ name: 'c', script: 'c.sh' }] };
}

interface Part {
  name?: string;
  bytes?: Uint8Array;
  type?: string;
}
function form(slug: string, bundle: unknown, parts: Part[], force = false) {
  const f = new FormData();
  f.set('manifest', new Blob([JSON.stringify(manifest(slug))], { type: 'application/json' }), 'manifest.json');
  f.set('workspace', new Blob([new Uint8Array(4)]), 'workspace.tgz');
  f.set('private', new Blob([new Uint8Array(4)]), 'private.tgz');
  f.set('learn', new Blob([JSON.stringify(bundle)], { type: 'application/json' }), 'learn.json');
  for (const p of parts) f.append('audio', new Blob([p.bytes ?? MP3], { type: p.type ?? 'audio/mpeg' }), p.name);
  if (force) f.set('force', 'true');
  return f;
}
const allParts = (b: ReturnType<typeof learn>): Part[] => keysOf(b).map((k) => ({ name: `${k}.mp3` }));
const publish = (env: Env, slug: string, bundle: unknown, parts: Part[], force = false, headers: Record<string, string> = SERVICE) =>
  call(env, 'POST', '/labs/publish', { body: form(slug, bundle, parts, force), headers });
const err = async (res: Response) => ((await res.json()) as any).error as { code: string; message: string };

describe('POST /labs/publish with narration clips', () => {
  it('stores each clip under labs/{slug}/{version}/audio/ and the bundle with its audio index', async () => {
    const { env, store } = makeEnv();
    const b = learn();
    const res = await publish(env, 'gw-lab', b, allParts(b));
    expect(res.status).toBe(201);
    for (const k of keysOf(b)) {
      expect(audioKey('gw-lab', '1.0.0', `${k}.mp3`)).toBe(`labs/gw-lab/1.0.0/audio/${k}.mp3`);
      expect(store.get(`labs/gw-lab/1.0.0/audio/${k}.mp3`)!.bytes).toEqual(MP3);
      expect(store.get(`labs/gw-lab/1.0.0/audio/${k}.mp3`)!.type).toBe('audio/mpeg');
    }
    const learnRes = await call(env, 'GET', '/labs/gw-lab/learn', { headers: SERVICE });
    const body = (await learnRes.json()) as any;
    expect(body.slug).toBe('gw-lab');
    expect(Object.keys(body.learn.audio.clips).sort()).toEqual(keysOf(b).sort());
  });

  it('refuses old-shape narration (caption and bubble lines) for a comic with voiceovers: 400 invalid_learn_bundle, run labs narrate, nothing stored', async () => {
    const { env, store } = makeEnv();
    const clips: Record<string, unknown> = {};
    const lines = legacyNarrationLines(COMIC as any).map((l) => {
      const key = clipKey(TTS_MODEL, l.voice, l.text, sha);
      clips[key] = { voice: l.voice, text: l.text, seconds: 2, bytes: MP3.length };
      return { panel: l.panel, kind: l.kind, ...(l.bubble !== undefined ? { bubble: l.bubble } : {}), clip: key };
    });
    const old = { ...learn(), audio: { model: TTS_MODEL, clips, lines } };
    const res = await publish(env, 'gw-lab', old, Object.keys(clips).map((k) => ({ name: `${k}.mp3` })));
    expect(res.status).toBe(400);
    const e = await err(res);
    expect(e.code).toBe('invalid_learn_bundle');
    expect(e.message).toMatch(/old caption-and-bubble format.*labs narrate/);
    expect([...store.keys()].filter((k) => k.includes('/audio/'))).toEqual([]);
  });

  it('still publishes an old comic (no voiceover) with its own old narration, until its lab is rewritten', async () => {
    const { env, store } = makeEnv();
    const oldComic = {
      title: 'Old',
      pages: [{ panels: [panel({ cast: ['jonas'], caption: 'Tuesday.', bubbles: [{ who: 'jonas', text: 'Which provider answered?' }], lines: ['x'] }), panel({ scene: 'portrait', cast: ['maren'], bubbles: [{ who: 'maren', text: 'Find out.' }] }), panel({ scene: 'screen', caption: 'A copy.', lines: ['$ run', 'ok'] }), panel({ scene: 'you', caption: 'Your turn.', lines: ['$ go'] })] }],
    };
    const clips: Record<string, unknown> = {};
    const lines = legacyNarrationLines(oldComic as any).map((l) => {
      const key = clipKey(TTS_MODEL, l.voice, l.text, sha);
      clips[key] = { voice: l.voice, text: l.text, seconds: 2, bytes: MP3.length };
      return { panel: l.panel, kind: l.kind, ...(l.bubble !== undefined ? { bubble: l.bubble } : {}), clip: key };
    });
    const res = await publish(env, 'old-lab', { ...learn(), comic: oldComic, audio: { model: TTS_MODEL, clips, lines } }, Object.keys(clips).map((k) => ({ name: `${k}.mp3` })));
    expect(res.status).toBe(201);
    expect([...store.keys()].filter((k) => k.includes('/audio/'))).toHaveLength(Object.keys(clips).length);
  });

  it('refuses a file name that is not <16 hex>.mp3 (traversal included), storing nothing', async () => {
    for (const name of ['../../private.tgz', 'abc.mp3', 'ZZZZZZZZZZZZZZZZ.mp3', `${'a'.repeat(16)}.wav`, `${'a'.repeat(16)}.mp3.exe`, `${'a'.repeat(15)}.mp3`]) {
      const { env, store } = makeEnv();
      const b = learn();
      const res = await publish(env, 'gw-lab', b, [...allParts(b), { name }]);
      expect(res.status, name).toBe(400);
      expect((await err(res)).code).toBe('invalid_audio');
      expect([...store.keys()].filter((k) => k.includes('/audio/')), name).toEqual([]);
      expect(store.has(currentKey('gw-lab'))).toBe(false);
    }
  });

  it('refuses a clip over 400 KB, a wrong content type, and something that is not an MP3', async () => {
    const big = new Uint8Array(400 * 1024 + 1);
    big.set(MP3);
    let { env } = makeEnv();
    const b = learn({ bytes: big.length });
    const k0 = keysOf(b)[0]!;
    let res = await publish(env, 'gw-lab', b, keysOf(b).map((k) => ({ name: `${k}.mp3`, bytes: big })));
    expect(res.status).toBe(400);
    expect((await err(res)).message).toMatch(/limit is 409600/);

    ({ env } = makeEnv());
    const good = learn();
    res = await publish(env, 'gw-lab', good, allParts(good).map((p, i) => (i === 0 ? { ...p, type: 'application/octet-stream' } : p)));
    expect(res.status).toBe(400);
    expect((await err(res)).message).toMatch(/not audio\/mpeg/);

    ({ env } = makeEnv());
    const html = new TextEncoder().encode('<html>'.padEnd(MP3.length, ' '));
    res = await publish(env, 'gw-lab', good, allParts(good).map((p, i) => (i === 0 ? { ...p, bytes: html } : p)));
    expect(res.status).toBe(400);
    expect((await err(res)).message).toMatch(/not an MP3/);
    expect(k0).toBeTruthy();
  });

  it('refuses a clip the bundle does not reference, a referenced clip that is missing, and a size the index contradicts', async () => {
    let { env } = makeEnv();
    const b = learn();
    let res = await publish(env, 'gw-lab', b, [...allParts(b), { name: `${'a'.repeat(16)}.mp3` }]);
    expect(res.status).toBe(400);
    expect((await err(res)).message).toMatch(/not referenced by the bundle's audio index/);

    ({ env } = makeEnv());
    res = await publish(env, 'gw-lab', b, allParts(b).slice(1));
    expect(res.status).toBe(400);
    expect((await err(res)).message).toMatch(/was not uploaded/);

    ({ env } = makeEnv());
    res = await publish(env, 'gw-lab', learn({ bytes: MP3.length + 1 }), allParts(b));
    expect(res.status).toBe(400);
    expect((await err(res)).message).toMatch(/the index says/);

    ({ env } = makeEnv());
    res = await publish(env, 'gw-lab', b, []);
    expect(res.status).toBe(400); // an index with no clips behind it
  });

  it('refuses clips with no audio index, and more than 80 clips', async () => {
    let { env } = makeEnv();
    const noIndex: any = learn();
    delete noIndex.audio;
    let res = await publish(env, 'gw-lab', noIndex, [{ name: `${'a'.repeat(16)}.mp3` }]);
    expect(res.status).toBe(400);
    expect((await err(res)).message).toMatch(/no audio index/);

    ({ env } = makeEnv());
    const b = learn();
    const parts = Array.from({ length: 81 }, (_, i) => ({ name: `${i.toString(16).padStart(16, '0')}.mp3` }));
    res = await publish(env, 'gw-lab', b, parts);
    expect(res.status).toBe(400);
    expect((await err(res)).message).toMatch(/at most 80/);
  });

  it('is service-key only, like every publish', async () => {
    const { env } = makeEnv();
    const b = learn();
    expect((await publish(env, 'gw-lab', b, allParts(b), false, {})).status).toBe(401);
    expect((await publish(env, 'gw-lab', b, allParts(b), false, { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('a forced re-publish leaves exactly this publish\'s clips', async () => {
    const { env, store } = makeEnv();
    const b = learn();
    await publish(env, 'gw-lab', b, allParts(b));
    store.set(audioKey('gw-lab', '1.0.0', `${'e'.repeat(16)}.mp3`), { bytes: MP3 });
    const again = await publish(env, 'gw-lab', b, allParts(b), true);
    expect(again.status).toBe(201);
    expect([...store.keys()].filter((k) => k.includes('/audio/')).sort()).toEqual(keysOf(b).map((k) => `labs/gw-lab/1.0.0/audio/${k}.mp3`).sort());
  });
});

describe('GET /labs/:slug/audio/:file', () => {
  async function published() {
    const { env, store } = makeEnv();
    const b = learn();
    await publish(env, 'gw-lab', b, allParts(b));
    return { env, store, file: `${keysOf(b)[0]!}.mp3` };
  }

  it('serves the clip as audio/mpeg, cached for a year, with ranges advertised', async () => {
    const { env, file } = await published();
    const res = await call(env, 'GET', `/labs/gw-lab/audio/${file}`, { headers: SERVICE });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(MP3.length));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
  });

  it('answers Range requests with 206 and the right slice', async () => {
    const { env, file } = await published();
    const get = (range: string) => call(env, 'GET', `/labs/gw-lab/audio/${file}`, { headers: { ...SERVICE, Range: range } });
    let res = await get('bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${MP3.length}`);
    expect(res.headers.get('content-length')).toBe('10');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3.slice(10, 20));

    res = await get('bytes=100-');
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3.slice(100));

    res = await get('bytes=-50');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes ${MP3.length - 50}-${MP3.length - 1}/${MP3.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3.slice(-50));

    res = await get(`bytes=${MP3.length + 5}-`);
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${MP3.length}`);

    // Several ranges (or another unit) are answered with the whole clip, which a server may always do.
    res = await get('bytes=0-1,5-6');
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
  });

  it('takes the service key and nothing else', async () => {
    const { env, file } = await published();
    expect((await call(env, 'GET', `/labs/gw-lab/audio/${file}`)).status).toBe(401);
    expect((await call(env, 'GET', `/labs/gw-lab/audio/${file}`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('404s an unknown lab, an unknown clip, and any name that is not a clip file', async () => {
    const { env, file } = await published();
    expect((await call(env, 'GET', `/labs/nope/audio/${file}`, { headers: SERVICE })).status).toBe(404);
    expect((await call(env, 'GET', `/labs/gw-lab/audio/${'a'.repeat(16)}.mp3`, { headers: SERVICE })).status).toBe(404);
    for (const name of ['manifest.json', 'learn.json', 'private.tgz', 'solution.tgz', '..%2Fprivate.tgz', `${file}.bak`, 'abc.mp3']) {
      const res = await call(env, 'GET', `/labs/gw-lab/audio/${name}`, { headers: SERVICE });
      expect(res.status, name).toBe(404);
    }
  });

  it('only ever reads <slug>/<version>/audio/<hash>.mp3, never checks or the solution', () => {
    const router = readFileSync(join(__dirname, '..', '..', 'src', 'router.ts'), 'utf8');
    const start = router.indexOf("app.get('/labs/:slug/audio/:file'");
    const handler = router.slice(start, router.indexOf('\n  app.', start + 10));
    expect(handler.indexOf('requireServiceAuth(')).toBeGreaterThan(-1);
    expect(handler.indexOf('requireServiceAuth(')).toBeLessThan(handler.indexOf('audioKey('));
    expect(handler).toContain('CLIP_FILE.test(file)');
    expect(handler).not.toMatch(/solutionKey\(|privateKey\(|workspaceKey\(|requireBrowserAuth\(/);
  });
});

describe('parseByteRange', () => {
  it('reads one range, clamps its end, and says when nothing is satisfiable', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-1', 0)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=5-2', 100)).toBeNull();
    expect(parseByteRange('items=0-9', 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,4-5', 100)).toBeNull();
    expect(parseByteRange('bytes=-', 100)).toBeNull();
  });
});
