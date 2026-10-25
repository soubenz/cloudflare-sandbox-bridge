/**
 * Narration for a short: one Workers AI text-to-speech clip per segment, word
 * timings for it from Workers AI Whisper, and the clips joined into one track.
 *
 * Everything the network makes is cached by content hash under the cache
 * directory (scripts/shorts/.cache by default, gitignored), so a re-render with
 * unchanged words makes no API call at all:
 *   tts/<sha256(model, speaker, text)>.mp3
 *   words/<sha256(whisper model, clip hash, processing)>.json
 *
 * Credentials come from the environment: CLOUDFLARE_API_TOKEN, and
 * CLOUDFLARE_ACCOUNT_ID (looked up from the token's first account when unset).
 * The token is never printed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';
export const SAMPLE_RATE = 48000;

const sha = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? p : Buffer.from(p)).update('\0');
  return h.digest('hex').slice(0, 24);
};

let accountIdPromise = null;
async function credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set (needed to make narration that is not cached yet)');
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return { token, accountId: process.env.CLOUDFLARE_ACCOUNT_ID };
  accountIdPromise ??= (async () => {
    const res = await fetch(`${API}/accounts`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    const id = body?.result?.[0]?.id;
    if (!res.ok || !id) throw new Error(`could not find a Cloudflare account for CLOUDFLARE_API_TOKEN (HTTP ${res.status}); set CLOUDFLARE_ACCOUNT_ID`);
    return id;
  })();
  return { token, accountId: await accountIdPromise };
}

async function runModel(model, init, what) {
  const { token, accountId } = await credentials();
  const url = `${API}/accounts/${accountId}/ai/run/${model}`;
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
      if (res.ok) return res;
      last = `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }
  throw new Error(`${what} failed (${last})`);
}

/** The mp3 bytes of `text` read by `speaker`, from the cache or Workers AI. */
export async function speak({ text, model, speaker }, cacheDir, log) {
  const file = join(cacheDir, 'tts', `${sha(model, speaker, text)}.mp3`);
  if (existsSync(file)) return { file, bytes: readFileSync(file), cached: true };
  log(`  tts   ${speaker}: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
  const res = await runModel(model, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, speaker }),
  }, `text-to-speech for "${text.slice(0, 40)}"`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`text-to-speech returned ${bytes.length} bytes for "${text.slice(0, 40)}"`);
  mkdirSync(join(cacheDir, 'tts'), { recursive: true });
  writeFileSync(file, bytes);
  return { file, bytes, cached: false };
}

/**
 * Whisper's words for a processed clip: [{ word, start, end }] in seconds of it.
 * `key` names the clip for the cache (the source mp3's hash and how it was
 * processed); `makeAudio()` makes the mp3 to send, only on a cache miss.
 */
export async function transcribe(key, makeAudio, model, cacheDir, log) {
  const file = join(cacheDir, 'words', `${sha(model, key)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  log(`  words ${model}`);
  const bytes = makeAudio();
  const turbo = /large-v3-turbo/.test(model);
  const res = await runModel(model, turbo
    ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio: bytes.toString('base64') }) }
    : { headers: { 'content-type': 'application/octet-stream' }, body: bytes }, 'transcription');
  const body = await res.json();
  const r = body.result || {};
  const raw = r.words || (r.segments || []).flatMap((s) => s.words || []);
  const words = raw.map((w) => ({ word: String(w.word).trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
  if (!words.length) throw new Error('transcription returned no word timings');
  mkdirSync(join(cacheDir, 'words'), { recursive: true });
  writeFileSync(file, JSON.stringify(words));
  return words;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Times for the script's own words (what the captions show), from Whisper's
 * words (what it heard). A plain edit-distance alignment on normalised words;
 * a script word Whisper heard differently ("Opalix" as "Opelix") or split in
 * two gets a time interpolated from its neighbours by length. Pure.
 */
export function alignWords(scriptText, heard, clipEnd) {
  const tokens = scriptText.split(/\s+/).filter(Boolean);
  const a = tokens.map(norm);
  const b = heard.map((w) => norm(w.word));
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1.2));
    }
  }
  const match = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1.2)) {
      if (a[i - 1] === b[j - 1] || (a[i - 1] && b[j - 1] && (a[i - 1].startsWith(b[j - 1]) || b[j - 1].startsWith(a[i - 1])))) match[i - 1] = j - 1;
      else match[i - 1] = -2 - (j - 1); // substituted: keep the slot's time as a weak anchor
      i--; j--;
    } else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }
  const out = tokens.map((text, i) => {
    const k = match[i] >= 0 ? match[i] : match[i] <= -2 ? -2 - match[i] : -1;
    return k >= 0 ? { text, start: heard[k].start, end: heard[k].end } : { text, start: NaN, end: NaN };
  });
  // Fill the gaps by character length between the anchors either side.
  let i = 0;
  while (i < n) {
    if (Number.isFinite(out[i].start)) { i++; continue; }
    let j = i;
    while (j < n && !Number.isFinite(out[j].start)) j++;
    const t0 = i > 0 ? out[i - 1].end : 0;
    const t1 = j < n ? out[j].start : clipEnd;
    const len = out.slice(i, j).reduce((s, w) => s + w.text.length + 1, 0);
    let t = t0;
    for (let k = i; k < j; k++) {
      const dt = ((t1 - t0) * (out[k].text.length + 1)) / len;
      out[k].start = t;
      out[k].end = t + dt;
      t += dt;
    }
    i = j;
  }
  for (let k = 0; k < n; k++) out[k].end = Math.max(out[k].end, out[k].start + 0.05);
  return out;
}

/**
 * The clip as it will be heard: mono float PCM at SAMPLE_RATE, slowed or sped
 * up by `tempo`, every pause inside it capped at about `maxPause` seconds (no
 * dead air), and cut to the speech with `padIn` / `padOut` seconds of its own
 * quiet either side.
 */
export function processClip(file, { tempo = 1, maxPause = 0.28, padIn = 0.03, padOut = 0.07 } = {}) {
  // silenceremove keeps a capped pause at about stop_duration + stop_silence (measured: 0.16 + keep).
  const keep = Math.max(0.02, maxPause - 0.16);
  const filters = [];
  if (Math.abs(tempo - 1) > 1e-3) filters.push(`atempo=${tempo}`);
  filters.push(`silenceremove=stop_periods=-1:stop_duration=0.14:stop_threshold=-42dB:stop_silence=${keep.toFixed(3)}:detection=peak`);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-af', filters.join(','), '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const loud = 10 ** (-42 / 20);
  let a = 0;
  let b = pcm.length - 1;
  while (a < b && Math.abs(pcm[a]) < loud) a++;
  while (b > a && Math.abs(pcm[b]) < loud) b--;
  const from = Math.max(0, a - Math.round(padIn * SAMPLE_RATE));
  const to = Math.min(pcm.length, b + Math.round(padOut * SAMPLE_RATE));
  return pcm.slice(from, to);
}

/** An mp3 of float PCM, small enough to send for transcription. */
export function mp3Of(samples) {
  return execFileSync('ffmpeg', ['-v', 'error', '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', '-', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', '-'], {
    input: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
    maxBuffer: 1 << 28,
  });
}

/** A mono 32-bit float WAV of `samples`. */
export function wavFile(samples) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
