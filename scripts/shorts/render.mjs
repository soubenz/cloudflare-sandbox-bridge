#!/usr/bin/env node
/**
 * Renders the explainer videos ("shorts") of a short.yaml: every entry of its
 * `videos` list, in each format, from one narration. See docs/shorts.md.
 *
 *   node scripts/shorts/render.mjs labs/<slug>/learn/short.yaml [options]
 *
 *   --formats <f>[,<f>]  vertical (1080x1920) and/or landscape (1920x1080); default both
 *   --video <id>[,<id>]  only these videos (default: every video in the file)
 *   --out <dir>          where the files go (default: scripts/shorts/.out)
 *   --stills <n>         also save n representative frames per format as PNG
 *   --at <t>[,<t>]       only save frames at these times (seconds), no MP4
 *   --check              make the narration, check the length and holds, write the timeline; no frames
 *   --strict             fail on hold warnings (a diagram step or terminal output shown too briefly)
 *   --workers <n>        browser pages drawing frames in parallel (default 3)
 *   --fps <n>            frames per second (default 30)
 *   --cache <dir>        narration cache (default: scripts/shorts/.cache)
 *
 * Writes <id>-vertical.mp4, <id>-landscape.mp4, a poster frame
 * <id>-landscape.jpg and a WebVTT sidecar <id>.vtt (captions for embedding). Narration (and its Whisper word timings) is made once
 * per video and cached by content hash, so a second format only redraws
 * frames. A video longer than 180 s fails before any frame is drawn.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { chromium } from 'playwright';
import { alignWords, mp3Of, processClip, SAMPLE_RATE, speak, transcribe, wavFile } from './narration.mjs';
import { assertLength, buildTimeline, MAX_SECONDS, PACE, toVtt } from './timeline.mjs';
import { brandElementIds, checkBrandBeats, loadManifest, prepareSceneAssets, trademarkLine } from './assets.mjs';
import { ICON_NAMES } from './page/canvas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const ORIGIN = 'http://shorts.local';
export const FORMATS = { vertical: { width: 1080, height: 1920 }, landscape: { width: 1920, height: 1080 } };
/** Each clip keeps this much of its own quiet either side of the speech. */
const PAD_IN = 0.03;
const PAD_OUT = 0.08;

const log = (...a) => console.error(...a);

function args(argv) {
  const o = { file: null, video: null, formats: Object.keys(FORMATS), out: join(HERE, '.out'), stills: 0, at: null, check: false, strict: false, workers: 3, fps: 30, cache: join(HERE, '.cache') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--video') o.video = val().split(',');
    else if (a === '--formats') o.formats = val().split(',');
    else if (a === '--out') o.out = resolve(val());
    else if (a === '--stills') o.stills = Number(val());
    else if (a === '--at') o.at = val().split(',').map(Number);
    else if (a === '--check') o.check = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--workers') o.workers = Math.max(1, Number(val()));
    else if (a === '--fps') o.fps = Number(val());
    else if (a === '--cache') o.cache = resolve(val());
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.file = resolve(a);
  }
  if (!o.file) throw new Error('usage: node scripts/shorts/render.mjs <short.yaml> [--formats vertical,landscape] [--video id] [--out dir] [--stills n] [--at t,...] [--check]');
  const bad = o.formats.filter((f) => !FORMATS[f]);
  if (bad.length || !o.formats.length) throw new Error(`--formats takes ${Object.keys(FORMATS).join(' and/or ')}, not ${bad.join(', ') || 'nothing'}`);
  return o;
}

// --- the script file -----------------------------------------------------------

const TTS_MODEL = '@cf/deepgram/aura-2-en';
const WHISPER = '@cf/openai/whisper-large-v3-turbo';

/** Secrets never reach a frame: anything token-shaped in a command or output is masked. */
const MASKS = [/(Bearer\s+)[^\s"']+/g, /\b((?:sk|pk|key|tok|ghp|xox[abp])[-_])[A-Za-z0-9_-]{10,}/g, /((?:token|api[_-]?key|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi];
function mask(text, extra = []) {
  let s = String(text ?? '');
  for (const re of MASKS) s = s.replace(re, '$1••••••••');
  for (const re of extra) s = s.replace(new RegExp(re, 'g'), '••••••••');
  return s;
}

/**
 * The voice provider: `workers-ai:<speaker>` (Workers AI Aura-2 text-to-speech)
 * or `dir:<folder>` (pre-made clips, one per segment; see docs/shorts.md).
 * A folder is relative to the short.yaml, else to the repository root.
 */
export function parseVoice(spec, base) {
  const s = String(spec ?? 'workers-ai:arcas').trim();
  const m = /^(workers-ai|dir):(.+)$/.exec(s);
  if (!m) throw new Error(`voice "${s}": use workers-ai:<speaker> (e.g. workers-ai:arcas) or dir:<folder>`);
  if (m[1] === 'workers-ai') return { provider: 'workers-ai', speaker: m[2].trim(), model: TTS_MODEL, label: s };
  const dir = [resolve(base, m[2].trim()), resolve(ROOT, m[2].trim())].find((p) => existsSync(p)) || resolve(base, m[2].trim());
  return { provider: 'dir', dir, label: s };
}

function loadScript(file) {
  const doc = parseYaml(readFileSync(file, 'utf8'));
  const assets = loadManifest();
  const videos = doc.videos || (doc.segments ? [doc] : []);
  if (!videos.length) throw new Error(`${file}: no \`videos\``);
  const base = dirname(file);
  return videos.map((v, i) => {
    if (!v.id) throw new Error(`${file}: video ${i + 1} has no id`);
    const segments = (v.segments || []).map((s, k) => {
      if (!s.vo) throw new Error(`${file}: video "${v.id}" segment ${k + 1} has no vo`);
      const visuals = (s.visuals || []).map((vis) => prepareVisual(vis, base));
      let scene = null;
      if (s.scene) {
        scene = { ...s.scene, elements: Object.fromEntries(Object.entries(s.scene.elements || {}).map(([id, el]) => [id, prepareVisual(el, base)])) };
      }
      return { id: s.id || `s${k + 1}`, vo: String(s.vo).replace(/\s+/g, ' ').trim(), visuals, scene, beats: s.beats || [] };
    });
    if (!segments.length) throw new Error(`${file}: video "${v.id}" has no segments`);
    // Brand marks and library icons (docs/assets.md): resolved against the asset manifest, inlined, never altered.
    const brands = new Set();
    let brandIds = [];
    for (const s of segments) {
      const where = `${file}: video "${v.id}" segment "${s.id}"`;
      if (s.scene) {
        const r = prepareSceneAssets(s.scene.elements, assets, { builtin: ICON_NAMES, where });
        s.scene.elements = r.elements;
        r.brands.forEach((b) => brands.add(b));
        brandIds = brandElementIds(r.elements);
      } else if (s.visuals.length) brandIds = [];
      checkBrandBeats(s.beats, brandIds, where);
    }
    let endCard = v.endCard ?? doc.endCard;
    if (endCard === false) {
      if (brands.size) log(`${v.id}: shows brand marks (${[...brands].join(', ')}) but has no end card; put "${trademarkLine(assets, [...brands])}" in the video description`);
    } else {
      const tm = endCard?.trademarks;
      const line = typeof tm === 'string' ? tm : tm === false ? null : tm === true || brands.size ? trademarkLine(assets, [...brands]) : null;
      endCard = { ...(endCard || {}), trademarks: line };
    }
    const cap = v.captions ?? doc.captions ?? 'small';
    const theme = v.theme ?? doc.theme ?? 'navy';
    if (!['navy', 'black'].includes(theme)) throw new Error(`${file}: theme must be navy or black, not ${theme}`);
    if (!['off', 'small', 'karaoke'].includes(cap)) throw new Error(`${file}: captions must be off, small or karaoke, not ${cap}`);
    const pace = { ...PACE, ...doc.pace, ...v.pace };
    for (const [k, val] of Object.entries(pace)) if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) throw new Error(`${file}: pace.${k} must be a number of seconds (or words), not ${JSON.stringify(val)}`);
    return {
      id: v.id,
      title: v.title || v.id,
      voice: parseVoice(v.voice ?? doc.voice, base),
      whisper: v.whisper || doc.whisper || WHISPER,
      pace,
      poster: v.poster,
      colors: { ...doc.colors, ...v.colors },
      theme: v.theme ?? doc.theme ?? 'navy',
      endCard,
      brands: [...brands],
      captions: v.captions ?? doc.captions ?? 'small',
      segments,
    };
  });
}

/** Reads what a visual takes from the repository (code lines) and masks secrets. */
function prepareVisual(vis, base) {
  const v = { ...vis };
  if (v.type === 'terminal') {
    v.command = mask(v.command, v.mask);
    v.output = mask(v.output, v.mask);
  }
  if (v.type === 'card' && Array.isArray(v.lines)) v.lines = v.lines.map((l) => (l && typeof l === 'object' ? { ...l, text: mask(l.text, v.mask) } : mask(l, v.mask)));
  if (v.type === 'code' && v.from) {
    const path = [resolve(base, v.from), resolve(ROOT, v.from)].find((p) => existsSync(p));
    if (!path) throw new Error(`code visual: no file ${v.from}`);
    const all = readFileSync(path, 'utf8').split('\n');
    const [a, b] = String(v.lines || `1-${all.length}`).split('-').map(Number);
    v.code = mask(all.slice(a - 1, b || a).join('\n'), v.mask);
    v.firstLine = a;
    v.file = v.file || relative(ROOT, path).split(sep).slice(-1)[0];
  }
  return v;
}

// --- narration ---------------------------------------------------------------------

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'flac'];

/** The pre-made clips of a `dir:` voice, checked against the segments: [{ file }]. */
function dirClips(voice, video) {
  const where = `voice ${voice.label}`;
  const mf = join(voice.dir, 'manifest.json');
  if (!existsSync(mf)) throw new Error(`${where}: no ${mf} (see docs/shorts.md, "Pre-made narration")`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(mf, 'utf8')); } catch (e) { throw new Error(`${where}: manifest.json is not JSON (${e.message})`); }
  const list = Array.isArray(manifest?.segments) ? manifest.segments : null;
  if (!list) throw new Error(`${where}: manifest.json needs { "segments": [{ "index": 1, "text": "..." }, ...] }`);
  if (list.length !== video.segments.length) throw new Error(`${where}: manifest.json lists ${list.length} clips, but video "${video.id}" has ${video.segments.length} segments`);
  return video.segments.map((s, k) => {
    const entry = list.find((e) => Number(e.index) === k + 1);
    const nn = String(k + 1).padStart(2, '0');
    if (!entry) throw new Error(`${where}: manifest.json has no entry with "index": ${k + 1} (segment "${s.id}")`);
    if (words(entry.text) !== words(s.vo)) {
      throw new Error(`${where}: clip ${nn} was made from "${entry.text}" but segment ${k + 1} ("${s.id}") now says "${s.vo}". Make the clip again or put the vo back.`);
    }
    const file = AUDIO_EXT.map((e) => join(voice.dir, `${nn}.${e}`)).find((p) => existsSync(p));
    if (!file) throw new Error(`${where}: no ${nn}.mp3 (or .${AUDIO_EXT.slice(1).join('/.')}) for segment ${k + 1} ("${s.id}")`);
    return { file };
  });
}

async function narrate(video, cache) {
  const segs = [];
  const how = { maxPause: video.pace.maxPause, padIn: PAD_IN, padOut: PAD_OUT };
  const premade = video.voice.provider === 'dir' ? dirClips(video.voice, video) : null;
  for (const [k, s] of video.segments.entries()) {
    let file;
    let key;
    if (premade) {
      file = premade[k].file;
      key = `dir|${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
    } else {
      const clip = await speak({ text: s.vo, model: video.voice.model, speaker: video.voice.speaker }, cache, log);
      file = clip.file;
      key = `tts|${clip.file.split(/[\\/]/).pop()}`;
    }
    const samples = processClip(file, how);
    const duration = samples.length / SAMPLE_RATE;
    // Whisper hears the clip as processed, so its times are already the video's.
    const heard = await transcribe(`${key}|${JSON.stringify(how)}`, () => mp3Of(samples), video.whisper, cache, log);
    segs.push({ ...s, samples, duration, words: alignWords(s.vo, heard, duration) });
  }
  return segs;
}

function mixTrack(segs, timeline) {
  const total = Math.ceil(timeline.duration * SAMPLE_RATE);
  const out = new Float32Array(total);
  segs.forEach((s, i) => {
    // A pause beat opened gaps in this clip: copy it piece by piece, leaving the gaps silent.
    let dst = Math.round(timeline.segments[i].audioStart * SAMPLE_RATE);
    let src = 0;
    const put = (end) => {
      const piece = s.samples.subarray(src, Math.min(end, s.samples.length));
      out.set(piece.subarray(0, Math.max(0, Math.min(piece.length, total - dst))), dst);
      dst += piece.length;
      src += piece.length;
    };
    for (const c of timeline.segments[i].cuts || []) {
      put(Math.round(c.at * SAMPLE_RATE));
      dst += Math.round(c.pad * SAMPLE_RATE);
    }
    put(s.samples.length);
  });
  return out;
}

// --- the page ----------------------------------------------------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const SERVED = ['scripts/shorts/page/', 'dashboard/src/', 'dashboard/public/', 'packages/design/'];

async function openPage(browser, format, timeline, library) {
  const page = await browser.newPage({ viewport: FORMATS[format], deviceScaleFactor: 1 });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    const file = resolve(ROOT, path);
    if (!SERVED.some((p) => path.startsWith(p)) || !file.startsWith(ROOT + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${ORIGIN}/scripts/shorts/page/index.html`);
  await page.waitForFunction(() => window.shorts && typeof window.shorts.init === 'function', null, { timeout: 15000 }).catch(() => {
    throw new Error(`the player did not load: ${errors.join('; ') || 'no error reported'}`);
  });
  await page.evaluate(([tl, lib, f]) => window.shorts.init(tl, lib, f), [timeline, library, format]);
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  return page;
}

async function frameAt(page, t, type = 'png') {
  await page.evaluate((x) => window.shorts.seek(x), t);
  return page.screenshot(type === 'jpeg' ? { type, quality: 90 } : { type });
}

function ffmpeg(argv, input) {
  return new Promise((ok, fail) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`))));
    if (input) input(p.stdin);
  });
}

const X264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1', '-g', '60'];

async function renderChunk(browser, format, timeline, library, fps, from, to, file, progress) {
  const page = await openPage(browser, format, timeline, library);
  await ffmpeg(['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', ...X264, '-r', String(fps), file], async (stdin) => {
    try {
      for (let i = from; i < to; i++) {
        const png = await frameAt(page, i / fps);
        if (!stdin.write(png)) await new Promise((r) => stdin.once('drain', r));
        progress();
      }
    } finally {
      stdin.end();
    }
  });
  await page.close();
}

/** The poster's moment: `poster` (seconds) if the video sets one, else the first diagram's last step, fully drawn. */
function posterTime(video, timeline) {
  if (typeof video.poster === 'number') return video.poster;
  const scenes = timeline.visuals.filter((v) => v.type === 'canvas');
  if (scenes.length > 1) {
    const s = scenes[1];
    const beats = s.beats.filter((b) => !b.run && !b.mark && b.layout !== 'split');
    return Math.min(s.end - 0.5, (beats[Math.floor(beats.length * 0.6)]?.t ?? s.start) + 1.2);
  }
  const d = timeline.visuals.find((v) => v.type === 'diagram') || timeline.visuals[0];
  const lastStep = d.steps ? d.steps[d.steps.length - 1].t : d.start;
  return Math.min(d.end - 0.3, lastStep + 1.6);
}

// --- main ----------------------------------------------------------------------------

async function renderFormat(o, video, format, timeline, needed, audio, browser) {
  const tag = `${video.id}-${format}`;
  const stillTimes = o.at ? [...o.at] : [];
  if (!o.at && o.stills > 0) {
    // Moments spread over the video: just after evenly spaced beats (or visuals, for legacy ones).
    const beats = timeline.visuals.flatMap((v) => (v.beats || []).map((b) => b.t));
    const moments = beats.length >= o.stills ? beats.sort((a, b) => a - b).map((t) => t + 1.2) : timeline.visuals.map((v) => v.start + (v.end - v.start) * 0.75);
    for (let k = 0; k < o.stills; k++) {
      const t = moments[Math.min(moments.length - 1, Math.round((k * (moments.length - 1)) / Math.max(1, o.stills - 1)))];
      stillTimes.push(Number(Math.min(t, timeline.duration - 0.2).toFixed(2)));
    }
  }
  const wantPoster = format === 'landscape' && !o.at;
  if (stillTimes.length || wantPoster) {
    const page = await openPage(browser, format, timeline, needed);
    for (const [k, t] of stillTimes.entries()) {
      const file = join(o.out, `${tag}-frame-${String(k + 1).padStart(2, '0')}-${t.toFixed(2)}s.png`);
      writeFileSync(file, await frameAt(page, t));
      log(`  still ${file}`);
    }
    if (wantPoster) {
      const file = join(o.out, `${video.id}-landscape.jpg`);
      writeFileSync(file, await frameAt(page, posterTime(video, timeline), 'jpeg'));
      log(`  poster ${file}`);
    }
    await page.close();
  }
  if (o.at) return;

  const frames = Math.ceil(timeline.duration * o.fps);
  const work = join(o.cache, 'build', tag);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const n = Math.min(o.workers, frames);
  const per = Math.ceil(frames / n);
  let done = 0;
  const t0 = Date.now();
  const tick = () => {
    done++;
    if (done % 150 === 0 || done === frames) log(`  ${format} frames ${done}/${frames} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  };
  const chunks = Array.from({ length: n }, (_, k) => ({ from: k * per, to: Math.min(frames, (k + 1) * per), file: join(work, `chunk-${k}.mp4`) })).filter((c) => c.from < c.to);
  await Promise.all(chunks.map((c) => renderChunk(browser, format, timeline, needed, o.fps, c.from, c.to, c.file, tick)));
  writeFileSync(join(work, 'chunks.txt'), chunks.map((c) => `file '${c.file}'`).join('\n'));
  const mp4 = join(o.out, `${tag}.mp4`);
  await ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', join(work, 'chunks.txt'),
    '-i', audio,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
    '-t', timeline.duration.toFixed(3),
    '-movflags', '+faststart',
    mp4,
  ]);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim();
  log(`${tag}: wrote ${mp4} (${Number(probe).toFixed(2)} s)`);
}

async function main() {
  const o = args(process.argv.slice(2));
  const videos = loadScript(o.file).filter((v) => !o.video || o.video.includes(v.id));
  if (!videos.length) throw new Error(`no video named ${o.video.join(', ')} in ${o.file}`);
  const library = Object.fromEntries((JSON.parse(readFileSync(join(ROOT, 'packages/catalogue/diagrams.json'), 'utf8')).diagrams || []).map((d) => [d.id, d]));
  mkdirSync(o.out, { recursive: true });

  for (const video of videos) {
    log(`${video.id}: narration (${video.voice.label})`);
    const segs = await narrate(video, o.cache);
    const timeline = buildTimeline(video, segs, video.pace, { captions: video.captions });
    timeline.fps = o.fps;
    timeline.title = video.title;
    timeline.theme = video.theme;
    assertLength(video.id, segs.map((s) => ({ id: s.id, duration: s.duration })), timeline.duration, MAX_SECONDS);
    const wordsTotal = segs.reduce((n, s) => n + s.words.length, 0);
    const speech = segs.reduce((n, s) => n + s.duration, 0);
    log(`${video.id}: ${timeline.duration.toFixed(2)} s, ${wordsTotal} words (${((wordsTotal / timeline.duration) * 60).toFixed(0)} wpm overall, ${((wordsTotal / speech) * 60).toFixed(0)} wpm while speaking), ${timeline.visuals.length} visuals, ${timeline.captions.length} captions`);
    for (const s of timeline.segments) log(`  ${s.id.padEnd(14)} voice ${s.audioStart.toFixed(2)}-${(s.audioStart + s.duration).toFixed(2)} s`);
    for (const w of timeline.warnings) log(`  warning: ${w}`);
    if (timeline.endCard?.trademarks) log(`  trademarks line (end card; also put it in the video description): ${timeline.endCard.trademarks}`);
    if (o.strict && timeline.warnings.length) throw new Error(`${timeline.warnings.length} hold warning(s) and --strict`);
    for (const v of timeline.visuals) if (v.type === 'diagram' && !library[v.id]) throw new Error(`segment "${v.segment}": no diagram "${v.id}" in packages/catalogue/diagrams.json`);
    writeFileSync(join(o.out, `${video.id}.vtt`), toVtt(timeline));
    log(`  subtitles ${join(o.out, `${video.id}.vtt`)}`);
    if (o.check) {
      writeFileSync(join(o.out, `${video.id}.timeline.json`), JSON.stringify(timeline, null, 1));
      continue;
    }
    const needed = Object.fromEntries(timeline.visuals.filter((v) => v.type === 'diagram').map((v) => [v.id, library[v.id]]));
    const audio = join(o.cache, 'build', `${video.id}-narration.wav`);
    mkdirSync(dirname(audio), { recursive: true });
    writeFileSync(audio, wavFile(mixTrack(segs, timeline)));

    const browser = await chromium.launch();
    try {
      for (const format of o.formats) await renderFormat(o, video, format, timeline, needed, audio, browser);
    } finally {
      await browser.close();
    }
  }
}

main().catch((e) => {
  log(`render: ${e.message}`);
  process.exit(1);
});
