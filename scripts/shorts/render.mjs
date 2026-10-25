#!/usr/bin/env node
/**
 * Renders the vertical explainer videos ("shorts") of a short.yaml: one
 * 1080x1920 H.264/AAC MP4 per entry of its `videos` list. See docs/shorts.md.
 *
 *   node scripts/shorts/render.mjs labs/<slug>/learn/short.yaml [options]
 *
 *   --video <id>[,<id>]  only these videos (default: every video in the file)
 *   --out <dir>          where the MP4s go (default: scripts/shorts/.out)
 *   --stills <n>         also save n representative frames as PNG next to each MP4
 *   --at <t>[,<t>]       only save frames at these times (seconds), no MP4
 *   --check              make the narration, check the length, print the timeline; no frames
 *   --workers <n>        browser pages drawing frames in parallel (default 3)
 *   --fps <n>            frames per second (default 30)
 *   --cache <dir>        narration cache (default: scripts/shorts/.cache)
 *
 * Narration is Workers AI text-to-speech plus Whisper word timings, cached by
 * content hash, so only changed words cost an API call (CLOUDFLARE_API_TOKEN,
 * and CLOUDFLARE_ACCOUNT_ID or the token's first account).
 * Frames: page/index.html in Playwright's Chromium, `shorts.seek(t)` per frame,
 * piped to ffmpeg. A video longer than 180 s fails before any frame is drawn.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { chromium } from 'playwright';
import { alignWords, mp3Of, processClip, SAMPLE_RATE, speak, transcribe, wavFile } from './narration.mjs';
import { assertLength, buildTimeline, MAX_SECONDS } from './timeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const ORIGIN = 'http://shorts.local';
const W = 1080;
const H = 1920;
/** Each clip keeps this much of its own quiet either side of the speech. */
const PAD_IN = 0.03;
const PAD_OUT = 0.07;

const log = (...a) => console.error(...a);

function args(argv) {
  const o = { file: null, video: null, out: join(HERE, '.out'), stills: 0, at: null, check: false, workers: 3, fps: 30, cache: join(HERE, '.cache') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--video') o.video = val().split(',');
    else if (a === '--out') o.out = resolve(val());
    else if (a === '--stills') o.stills = Number(val());
    else if (a === '--at') o.at = val().split(',').map(Number);
    else if (a === '--check') o.check = true;
    else if (a === '--workers') o.workers = Math.max(1, Number(val()));
    else if (a === '--fps') o.fps = Number(val());
    else if (a === '--cache') o.cache = resolve(val());
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.file = resolve(a);
  }
  if (!o.file) throw new Error('usage: node scripts/shorts/render.mjs <short.yaml> [--video id] [--out dir] [--stills n] [--at t,...] [--check]');
  return o;
}

// --- the script file -----------------------------------------------------------

const DEFAULTS = {
  voice: { model: '@cf/deepgram/aura-2-en', speaker: 'arcas', tempo: 1 },
  whisper: '@cf/openai/whisper-large-v3-turbo',
  pace: { lead: 0.1, gap: 0.26, tail: 1.0, visualLead: 0.14 },
};

/** Secrets never reach a frame: anything token-shaped in a command or output is masked. */
const MASKS = [/(Bearer\s+)[^\s"']+/g, /\b((?:sk|pk|key|tok|ghp|xox[abp])[-_])[A-Za-z0-9_-]{10,}/g, /((?:token|api[_-]?key|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi];
function mask(text, extra = []) {
  let s = String(text ?? '');
  for (const re of MASKS) s = s.replace(re, '$1••••••••');
  for (const re of extra) s = s.replace(new RegExp(re, 'g'), '••••••••');
  return s;
}

function loadScript(file) {
  const doc = parseYaml(readFileSync(file, 'utf8'));
  const videos = doc.videos || (doc.segments ? [doc] : []);
  if (!videos.length) throw new Error(`${file}: no \`videos\``);
  const base = dirname(file);
  return videos.map((v, i) => {
    if (!v.id) throw new Error(`${file}: video ${i + 1} has no id`);
    const segments = (v.segments || []).map((s, k) => {
      if (!s.vo) throw new Error(`${file}: video "${v.id}" segment ${k + 1} has no vo`);
      const visuals = (s.visuals || []).map((vis) => prepareVisual(vis, base));
      return { id: s.id || `s${k + 1}`, vo: String(s.vo).trim(), visuals };
    });
    if (!segments.length) throw new Error(`${file}: video "${v.id}" has no segments`);
    return {
      id: v.id,
      title: v.title || v.id,
      voice: { ...DEFAULTS.voice, ...doc.voice, ...v.voice },
      whisper: v.whisper || doc.whisper || DEFAULTS.whisper,
      pace: { ...DEFAULTS.pace, ...doc.pace, ...v.pace },
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

async function narrate(video, cache) {
  const segs = [];
  const tempo = Number(video.voice.tempo) || 1;
  const maxPause = Number(video.pace.maxPause ?? 0.28);
  for (const s of video.segments) {
    const clip = await speak({ text: s.vo, model: video.voice.model, speaker: video.voice.speaker }, cache, log);
    const how = { tempo, maxPause, padIn: PAD_IN, padOut: PAD_OUT };
    const samples = processClip(clip.file, how);
    const duration = samples.length / SAMPLE_RATE;
    // Whisper hears the clip as processed, so its times are already the video's.
    const heard = await transcribe(`${clip.file.split(/[\\/]/).pop()}|${JSON.stringify(how)}`, () => mp3Of(samples), video.whisper, cache, log);
    const words = alignWords(s.vo, heard, duration);
    segs.push({ ...s, samples, duration, words });
  }
  return segs;
}

function mixTrack(segs, timeline) {
  const total = Math.ceil(timeline.duration * SAMPLE_RATE);
  const out = new Float32Array(total);
  segs.forEach((s, i) => {
    const at = Math.round(timeline.segments[i].audioStart * SAMPLE_RATE);
    out.set(s.samples.subarray(0, Math.max(0, Math.min(s.samples.length, total - at))), at);
  });
  return out;
}

// --- the page ----------------------------------------------------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const SERVED = ['scripts/shorts/page/', 'dashboard/src/', 'dashboard/public/', 'packages/design/'];

async function openPage(browser, timeline, library) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
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
  await page.evaluate(([tl, lib]) => window.shorts.init(tl, lib), [timeline, library]);
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  return page;
}

async function frameAt(page, t) {
  await page.evaluate((x) => window.shorts.seek(x), t);
  return page.screenshot({ type: 'png', animations: 'allow', caret: 'initial' });
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

async function renderChunk(browser, timeline, library, fps, from, to, file, progress) {
  const page = await openPage(browser, timeline, library);
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

// --- main ----------------------------------------------------------------------------

async function main() {
  const o = args(process.argv.slice(2));
  const videos = loadScript(o.file).filter((v) => !o.video || o.video.includes(v.id));
  if (!videos.length) throw new Error(`no video named ${o.video.join(', ')} in ${o.file}`);
  const library = Object.fromEntries((JSON.parse(readFileSync(join(ROOT, 'packages/catalogue/diagrams.json'), 'utf8')).diagrams || []).map((d) => [d.id, d]));
  mkdirSync(o.out, { recursive: true });

  for (const video of videos) {
    log(`${video.id}: narration (${video.voice.speaker}, tempo ${video.voice.tempo})`);
    const segs = await narrate(video, o.cache);
    const timeline = buildTimeline(video, segs, { ...video.pace, padIn: PAD_IN, padOut: PAD_OUT });
    timeline.fps = o.fps;
    timeline.title = video.title;
    assertLength(video.id, segs.map((s) => ({ id: s.id, duration: s.duration })), timeline.duration, MAX_SECONDS);
    log(`${video.id}: ${timeline.duration.toFixed(2)} s, ${timeline.visuals.length} visuals, ${timeline.captions.length} captions`);
    for (const s of timeline.segments) log(`  ${s.id.padEnd(14)} voice ${s.audioStart.toFixed(2)}-${(s.audioStart + s.duration).toFixed(2)} s`);
    if (o.check) {
      writeFileSync(join(o.out, `${video.id}.timeline.json`), JSON.stringify(timeline, null, 1));
      continue;
    }
    const needed = Object.fromEntries(timeline.visuals.filter((v) => v.type === 'diagram').map((v) => {
      if (!library[v.id]) throw new Error(`segment "${v.segment}": no diagram "${v.id}" in packages/catalogue/diagrams.json`);
      return [v.id, library[v.id]];
    }));

    const browser = await chromium.launch();
    try {
      const stillTimes = o.at || [];
      if (!o.at && o.stills > 0) {
        // Representative frames: a moment well into each of n visuals spread over the video.
        const vs = timeline.visuals;
        for (let k = 0; k < o.stills; k++) {
          const v = vs[Math.min(vs.length - 1, Math.round((k * (vs.length - 1)) / Math.max(1, o.stills - 1)))];
          stillTimes.push(Number((v.start + (v.end - v.start) * 0.72).toFixed(2)));
        }
      }
      if (stillTimes.length) {
        const page = await openPage(browser, timeline, needed);
        for (const [k, t] of stillTimes.entries()) {
          const file = join(o.out, `${video.id}-frame-${String(k + 1).padStart(2, '0')}-${t.toFixed(2)}s.png`);
          writeFileSync(file, await frameAt(page, t));
          log(`  still ${file}`);
        }
        await page.close();
      }
      if (o.at) continue;

      const frames = Math.ceil(timeline.duration * o.fps);
      const work = join(o.cache, 'build', video.id);
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const audio = join(work, 'narration.wav');
      writeFileSync(audio, wavFile(mixTrack(segs, timeline)));

      const n = Math.min(o.workers, frames);
      const per = Math.ceil(frames / n);
      let done = 0;
      const t0 = Date.now();
      const tick = () => {
        done++;
        if (done % 60 === 0 || done === frames) log(`  frames ${done}/${frames} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      };
      const chunks = Array.from({ length: n }, (_, k) => ({ from: k * per, to: Math.min(frames, (k + 1) * per), file: join(work, `chunk-${k}.mp4`) })).filter((c) => c.from < c.to);
      await Promise.all(chunks.map((c) => renderChunk(browser, timeline, needed, o.fps, c.from, c.to, c.file, tick)));
      writeFileSync(join(work, 'chunks.txt'), chunks.map((c) => `file '${c.file}'`).join('\n'));

      const mp4 = join(o.out, `${video.id}.mp4`);
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
      log(`${video.id}: wrote ${mp4} (${Number(probe).toFixed(2)} s)`);
    } finally {
      await browser.close();
    }
  }
}

main().catch((e) => {
  log(`render: ${e.message}`);
  process.exit(1);
});
