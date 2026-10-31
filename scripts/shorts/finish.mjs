#!/usr/bin/env node
/**
 * Finishes rendered shorts: a SoundCraft loudness pass on the narration, the
 * polished audio muxed back into both MP4s (video stream copied), and a
 * FilmCraft project per video for the owner. See docs/shorts.md ("Finish").
 *
 *   node scripts/shorts/finish.mjs labs/<slug>/learn/short.yaml [options]
 *
 *   --in <dir>           where render.mjs wrote the MP4s and VTTs (default: scripts/shorts/.out)
 *   --out <dir>          where finished files go, one folder per video (default: <in>/finished)
 *   --video <id>[,<id>]  only these videos (default: every video in the file)
 *   --lufs <n>           integrated loudness target (default -14)
 *   --true-peak <n>      highest true peak allowed in the final MP4, dBTP (default -1)
 *   --fc-export <id>|none  export this video's vertical sequence from FilmCraft and compare it
 *                        with the ffmpeg-muxed MP4 (default: the first video)
 *   --no-filmcraft       skip the FilmCraft hand-off
 *   --fetch-tools        ignore installed CLIs and use the pinned release under scripts/shorts/.tools/
 *   --cache <dir>        narration cache (default: scripts/shorts/.cache)
 *
 * Needs ffmpeg/ffprobe, and soundcraft-cli and filmcraft-cli 0.15.0: found on PATH, under
 * /opt/craft/<app>/bin (scripts/setup-cloud-env.sh puts them there), or downloaded from the
 * official GitHub release into scripts/shorts/.tools/ and checked against a pinned SHA-256.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { arch } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, '.tools');
const RATE = 48000;
const log = (...a) => console.error(...a);

/** The pinned releases: tarball SHA-256 as listed in each release's SHA256SUMS.txt. */
const PINNED = {
  soundcraft: {
    version: '0.15.0',
    sha256: {
      x86_64: '16ef23ef62ec20f5fcc53e04abaaff527095e505f5608b47ab1b72b1c8e9ed20',
      aarch64: '595cfe17b14e6c39866f55cda38e5eb84a12cc181aec74942d81b4e3fb52f9ea',
    },
  },
  filmcraft: {
    version: '0.15.0',
    sha256: {
      x86_64: '22b106b4ca6294d9b3e9a4af40b40a653a1897437364805046a01ddbaa4b22c1',
      aarch64: '2cb66b8fe26f0038f3cd78532b951b6625fef162f84b8564289679bbbdce1429',
    },
  },
};

/** The narration chain. Track: trim to about -20 LUFS, gentle de-ess, gentle compression.
 *  Master: a gain to the target, then the maximizer as a sample-peak ceiling. */
const CHAIN = {
  preLufs: -20,
  deEsser: { freq: 6500, threshold: -26, range: 6 },
  compressor: { threshold: -24, ratio: 2.5, attack: 10, release: 120, knee: 6 },
  ceiling: -1.5,
};

function args(argv) {
  const o = { file: null, in: join(HERE, '.out'), out: null, video: null, lufs: -14, truePeak: -1, fcExport: null, filmcraft: true, fetchTools: false, cache: join(HERE, '.cache') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') o.in = resolve(argv[++i]);
    else if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--video') o.video = argv[++i].split(',');
    else if (a === '--lufs') o.lufs = Number(argv[++i]);
    else if (a === '--true-peak') o.truePeak = Number(argv[++i]);
    else if (a === '--fc-export') o.fcExport = argv[++i];
    else if (a === '--no-filmcraft') o.filmcraft = false;
    else if (a === '--fetch-tools') o.fetchTools = true;
    else if (a === '--cache') o.cache = resolve(argv[++i]);
    else if (!a.startsWith('--') && !o.file) o.file = resolve(a);
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.file) throw new Error('usage: node scripts/shorts/finish.mjs <short.yaml> [--in dir] [--out dir] [--video id] [--lufs -14] [--true-peak -1] [--fc-export id|none] [--no-filmcraft] [--fetch-tools]');
  o.out ??= join(o.in, 'finished');
  return o;
}

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { maxBuffer: 1 << 30, encoding: opts.binary ? 'buffer' : 'utf8', cwd: opts.cwd });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${argv.slice(0, 3).join(' ')} … exited ${r.status}: ${String(r.stderr).slice(-800)}`);
  return r;
}

// ---------------------------------------------------------------- tools

function versionOf(bin) {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** PATH, then /opt/craft, then scripts/shorts/.tools, then download the pinned release. */
function tool(app, fetchOnly) {
  const pin = PINNED[app];
  const name = `${app}-cli`;
  const cpu = arch() === 'arm64' ? 'aarch64' : 'x86_64';
  const base = `${app}-${pin.version}-linux-${cpu}`;
  const local = join(TOOLS, base, 'bin', name);
  const candidates = fetchOnly ? [local] : [
    ...(process.env.PATH || '').split(':').filter(Boolean).map((d) => join(d, name)),
    join('/opt/craft', app, 'bin', name),
    local,
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const v = versionOf(c);
    if (v && v.includes(pin.version)) return c;
    log(`  ${c} reports "${v}", not ${pin.version}; looking further`);
  }
  const sha = pin.sha256[cpu];
  const url = `https://github.com/storytold/${app}/releases/download/v${pin.version}`;
  const dl = join(TOOLS, 'downloads', base);
  rmSync(dl, { recursive: true, force: true });
  mkdirSync(dl, { recursive: true });
  log(`  fetching ${url}/${base}.tar.gz`);
  sh('curl', ['-fsSL', '--retry', '3', '-o', join(dl, `${base}.tar.gz`), `${url}/${base}.tar.gz`]);
  sh('curl', ['-fsSL', '--retry', '3', '-o', join(dl, 'SHA256SUMS.txt'), `${url}/SHA256SUMS.txt`]);
  const got = createHash('sha256').update(readFileSync(join(dl, `${base}.tar.gz`))).digest('hex');
  const listed = readFileSync(join(dl, 'SHA256SUMS.txt'), 'utf8').split('\n').find((l) => l.trim().endsWith(`${base}.tar.gz`))?.split(/\s+/)[0];
  if (got !== sha || listed !== sha) throw new Error(`${base}.tar.gz: sha256 ${got}, release lists ${listed}, pinned ${sha}; refusing to use it`);
  sh('tar', ['-xzf', join(dl, `${base}.tar.gz`), '-C', TOOLS]);
  rmSync(dl, { recursive: true, force: true });
  const v = versionOf(local);
  if (!v || !v.includes(pin.version)) throw new Error(`${local} did not run after unpacking (${v})`);
  log(`  ${name} ${pin.version}: sha256 verified, unpacked to ${join(TOOLS, base)}`);
  return local;
}

// ---------------------------------------------------------------- measuring

function probe(file) {
  const j = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,duration,start_time,nb_frames,sample_rate,channels,duration_ts,r_frame_rate,bit_rate', '-of', 'json', file]).stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(j.format.duration),
    video: v && { codec: v.codec_name, duration: Number(v.duration), start: Number(v.start_time), frames: Number(v.nb_frames), fps: v.r_frame_rate },
    audio: a && { codec: a.codec_name, duration: Number(a.duration), start: Number(a.start_time), rate: Number(a.sample_rate), channels: a.channels, samples: Number(a.duration_ts), kbps: Math.round(Number(a.bit_rate) / 1000) },
  };
}

/** ffmpeg's EBU R128 meter: integrated loudness, range and true peak. */
function ebur128(file) {
  const err = sh('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true+sample', '-f', 'null', '-']).stderr;
  const sum = err.slice(err.lastIndexOf('Summary:'));
  const num = (re) => Number(sum.match(re)?.[1]);
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/True peak:\s+Peak:\s+(-?[\d.inf]+) dBFS/), samplePeak: num(/Sample peak:\s+Peak:\s+(-?[\d.inf]+) dBFS/) };
}

/** SoundCraft's own meter: import, bounce, read the report it prints (lufs, peak, true peak). */
function scMeasure(sc, file, work) {
  let src = file;
  if (!/\.wav$/i.test(file)) {
    // SoundCraft 0.15 decodes AAC about 60 ms short; decode with ffmpeg so it meters every sample.
    src = join(work, 'meter-src.wav');
    sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_f32le', src]);
  }
  const out = join(work, 'meter.wav');
  const r = scBounce(sc, [`file.import_audio ${JSON.stringify({ path: src })}`], out, work);
  rmSync(out, { force: true });
  return { lufs: r.lufs, truePeak: r.true_peak_db, samplePeak: r.peak_db, seconds: r.seconds };
}

/** Runs SoundCraft engine commands (one `ID JSON` per line), bounces the mix, returns its report. */
function scBounce(sc, lines, outWav, work, save) {
  const script = join(work, 'soundcraft.txt');
  writeFileSync(script, lines.join('\n') + '\n');
  const r = sh(sc, ['script', script, '--bounce', outWav, ...(save ? ['--save', save] : [])], { cwd: work });
  const report = r.stdout.split('\n').filter((l) => l.startsWith('{') && l.includes('"lufs"')).pop();
  if (!report) throw new Error(`soundcraft bounce printed no report:\n${r.stdout.slice(-600)}`);
  return JSON.parse(report);
}

/** Decoded audio as mono float samples (channel 0, or the mono file), optionally filtered. */
function pcm(file, filter) {
  const af = ['pan=mono|c0=c0', filter].filter(Boolean).join(',');
  const buf = sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-af', af, '-ar', String(RATE), '-f', 'f32le', '-'], { binary: true }).stdout;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/** The lag (samples) of b against a that best lines up a window starting at `at` seconds. */
function lag(a, b, at, win = 0.4, max = 0.05) {
  const s = Math.round(at * RATE);
  const n = Math.round(win * RATE);
  const L = Math.round(max * RATE);
  let best = 0;
  let bestC = -Infinity;
  let ea = 0;
  for (let i = 0; i < n; i++) ea += a[s + i] ** 2;
  for (let k = -L; k <= L; k++) {
    let c = 0;
    let eb = 0;
    for (let i = 0; i < n; i++) {
      const y = b[s + i + k] || 0;
      c += a[s + i] * y;
      eb += y * y;
    }
    const r = c / Math.sqrt(ea * eb || 1);
    if (r > bestC) [bestC, best] = [r, k];
  }
  return { lag: best, r: Number(bestC.toFixed(3)) };
}

const rmsDb = (x, from, to) => {
  let e = 0;
  const a = Math.max(0, Math.round(from * RATE));
  const b = Math.min(x.length, Math.round(to * RATE));
  for (let i = a; i < b; i++) e += x[i] * x[i];
  return Number((10 * Math.log10(e / Math.max(1, b - a) + 1e-12)).toFixed(1));
};

/** Speech windows to line up: the loudest cue word in each quarter of the video. */
function syncPoints(cues, duration, ref) {
  const pts = cues.map((c) => c.t + 0.1).filter((t) => t > 1 && t < duration - 1);
  return [0, 1, 2, 3].map((q) => {
    const inQ = pts.filter((t) => t >= (q * duration) / 4 && t < ((q + 1) * duration) / 4);
    return inQ.reduce((best, t) => (rmsDb(ref, t, t + 0.4) > rmsDb(ref, best, best + 0.4) ? t : best), inQ[0]);
  }).filter((t) => t !== undefined);
}

/** Line-up checks use the band below 3 kHz, which the de-esser leaves alone: its dynamic
 *  high-band cut moves the phase of sibilants, which a full-band correlation reads as a 1-sample shift. */
const SYNC_BAND = 'lowpass=f=3000:poles=2,lowpass=f=3000:poles=2';
/** How loud 5 kHz and up is against the whole signal, in dB: the de-esser's footprint. */
const sibilance = (file) => {
  const all = pcm(file);
  const hf = pcm(file, 'highpass=f=5000:poles=2,highpass=f=5000:poles=2');
  return Number((rmsDb(hf, 0, hf.length / RATE) - rmsDb(all, 0, all.length / RATE)).toFixed(1));
};

// ---------------------------------------------------------------- timeline

/** Rebuilds <id>.timeline.json with `render.mjs --check` (cached narration, no frames, no API call). */
function timelines(o, ids, work) {
  const dir = join(work, 'timelines');
  mkdirSync(dir, { recursive: true });
  sh(process.execPath, [join(HERE, 'render.mjs'), o.file, '--check', '--video', ids.join(','), '--out', dir, '--cache', o.cache]);
  return dir;
}

/** One marker per page break and per cue word, from the canvas beats. */
function markers(timeline) {
  const out = [];
  for (const v of timeline.visuals) {
    for (const b of v.beats || []) {
      if (b.page) out.push({ t: b.t, kind: 'page', name: `page: ${b.page}`, comment: `page break (${b.transition || 'erase'})${typeof b.at === 'string' ? ` on "${b.at}"` : ''} · segment ${b.segment}`, color: 'Rose' });
      else if (typeof b.at === 'string') {
        const what = Object.keys(b).filter((k) => !['at', 't', 'segment', 'stagger', 'times'].includes(k)).map((k) => (k === 'pause' ? `pause ${b.pause}s` : `${k}: ${[].concat(b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? Object.keys(b[k]) : b[k]).join(' ')}`)).join(', ');
        out.push({ t: b.t, kind: 'cue', name: b.at, comment: `cue · segment ${b.segment}${what ? ` · ${what}` : ''}`, color: 'Green' });
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  // A pause beat opens quiet before the beat it makes room for, on the same phrase: keep one
  // marker, on the word (the later beat), and note the pause.
  const kept = [];
  for (const m of out) {
    const prev = kept.find((p) => p.kind === m.kind && p.name === m.name && m.t - p.t < 1.5);
    if (!prev) kept.push(m);
    else if (/· pause [\d.]+s$/.test(prev.comment)) Object.assign(prev, { t: m.t, comment: `${m.comment} (after a ${prev.comment.match(/pause ([\d.]+s)$/)[1]} pause)` });
  }
  return kept;
}

// ---------------------------------------------------------------- audio

function polish(o, sc, id, raw, dir, work) {
  const scDir = join(dir, 'soundcraft');
  rmSync(scDir, { recursive: true, force: true });
  mkdirSync(scDir, { recursive: true });
  const src = join(scDir, `${id}-narration-raw.wav`);
  copyFileSync(raw, src);
  const before = scMeasure(sc, src, work);
  const ins = (slot, plugin, params) => [
    `mix.insert ${JSON.stringify({ track: 2, slot, plugin })}`,
    // mix.insert ignores its `params` in 0.15: set them in a second command.
    `mix.insert_params ${JSON.stringify({ track: 2, slot, params })}`,
  ];
  const chain = (trim, ceiling, master, deEss = true) => [
    `file.import_audio ${JSON.stringify({ path: src })}`,
    ...ins(0, 'gain', { gain: Number((CHAIN.preLufs - before.lufs).toFixed(2)) }),
    ...(deEss ? ins(1, 'de_esser', CHAIN.deEsser) : []),
    ...ins(2, 'compressor', CHAIN.compressor),
    `track.new ${JSON.stringify({ kind: 'master', format: 'stereo', name: 'Master' })}`,
    `mix.insert ${JSON.stringify({ track: master, slot: 0, plugin: 'gain' })}`,
    `mix.insert_params ${JSON.stringify({ track: master, slot: 0, params: { gain: Number(trim.toFixed(2)) } })}`,
    `mix.insert ${JSON.stringify({ track: master, slot: 1, plugin: 'maximizer' })}`,
    `mix.insert_params ${JSON.stringify({ track: master, slot: 1, params: { threshold: 0, ceiling, release: 50 } })}`,
  ];
  const out = join(dir, `${id}-narration.wav`);
  // The master track's id: the import makes source 1, clip 3 on track 2, so track.new returns 4.
  const MASTER = 4;
  let trim = 0;
  let ceiling = CHAIN.ceiling;
  let r;
  const passes = [];
  for (let pass = 1; pass <= 4; pass++) {
    r = scBounce(sc, chain(trim, ceiling, MASTER), out, work, join(scDir, `${id}.scraft`));
    passes.push({ trim: Number(trim.toFixed(2)), lufs: Number(r.lufs.toFixed(2)), truePeak: Number(r.true_peak_db.toFixed(2)) });
    if (Math.abs(r.lufs - o.lufs) <= 0.15) break;
    trim += o.lufs - r.lufs;
  }
  if (Math.abs(r.lufs - o.lufs) > 0.3) throw new Error(`${id}: SoundCraft pass reached ${r.lufs.toFixed(2)} LUFS, not ${o.lufs}: ${JSON.stringify(passes)}`);
  // The de-esser's footprint: the same chain without it, compared above 5 kHz.
  const plain = join(work, 'no-de-ess.wav');
  scBounce(sc, chain(trim, ceiling, MASTER, false), plain, work);
  const deEss = { hfWithoutDb: sibilance(plain), hfWithDb: sibilance(out) };
  deEss.reductionDb = Number((deEss.hfWithoutDb - deEss.hfWithDb).toFixed(1));
  rmSync(plain, { force: true });
  return { before, src, out, report: r, passes, ceiling, deEss };
}

function mux(video, wav, out) {
  sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', wav,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE), '-ac', '2',
    '-map_metadata', '0', '-movflags', '+faststart', out]);
}

const videoHash = (file) => sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'md5', '-']).stdout.trim();

// ---------------------------------------------------------------- FilmCraft

const TICKS = 254016000000;

function fcRun(fc, steps, work, name, project, saveAs) {
  const file = join(work, `${name}.jsonl`);
  writeFileSync(file, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  const r = sh(fc, ['run', file, '--compact', ...(project ? ['--project', project, '--save'] : []), ...(saveAs ? ['--save-as', saveAs] : [])], { allowFail: true });
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const bad = lines.filter((l) => !l.ok);
  if (r.status !== 0 || bad.length) throw new Error(`filmcraft ${name}: ${JSON.stringify(bad).slice(0, 600)} ${r.stderr.slice(-400)}`);
  return lines;
}

function filmcraft(fc, id, dir, timeline, marks, work) {
  const proj = join(dir, `${id}.fcproj`);
  rmSync(proj, { force: true });
  const media = { vertical: join(dir, `${id}-vertical.mp4`), landscape: join(dir, `${id}-landscape.mp4`), wav: join(dir, `${id}-narration.wav`) };
  const first = fcRun(fc, [
    { id: 'file.newSequence', params: { name: `${id} vertical`, width: 1080, height: 1920, fps: 30, sampleRate: RATE, video: 1, audio: 2 } },
    { id: 'file.import', params: { paths: [media.vertical, media.landscape, media.wav] } },
  ], work, 'fc-1', null, proj);
  const seqV = first[0].result.sequence;
  const tree = JSON.parse(sh(fc, ['inspect', 'project', '--project', proj, '--compact']).stdout).root.children;
  const item = (path) => tree.find((c) => c.name === path.split('/').pop()).item;
  const build = (format, w, h) => [
    ...(format === 'landscape' ? [{ id: 'file.newSequence', params: { name: `${id} landscape`, width: w, height: h, fps: 30, sampleRate: RATE, video: 1, audio: 2 } }] : []),
    { id: 'timeline.place', params: { item: item(media[format]), track: 'V1', seconds: 0, audio: false } },
    { id: 'timeline.place', params: { item: item(media.wav), track: 'A1', seconds: 0 } },
    { id: 'captions.import', params: { path: join(dir, `${id}.vtt`), name: 'English' } },
    { id: 'captions.setTrack', params: { track: 'C1', language: 'en' } },
    { id: 'timeline.setTrack', params: { track: 'V1', name: 'Picture' } },
    { id: 'timeline.setTrack', params: { track: 'A1', name: 'Narration (SoundCraft)' } },
    { id: 'timeline.setTrack', params: { track: 'A2', name: 'Music (empty)' } },
    ...marks.map((m) => ({ id: 'markers.add', params: { target: 'program', time: Math.round(m.t * TICKS), name: m.name, comment: m.comment, color: m.color } })),
    ...(format === 'vertical' ? [
      { id: 'markers.exportCsv', params: { path: join(dir, `${id}-markers.csv`) } },
      { id: 'captions.export', params: { path: join(dir, `${id}.srt`) } },
    ] : []),
    { id: 'file.exportOtio', params: { path: join(dir, `${id}-${format}.otio`) } },
    { id: 'file.exportFcp7Xml', params: { path: join(dir, `${id}-${format}.xml`) } },
  ];
  const lines = fcRun(fc, [...build('vertical', 1080, 1920), ...build('landscape', 1920, 1080), { id: 'sequence.open', params: { item: seqV } }], work, 'fc-2', proj);
  const captions = lines.filter((l) => l.id === 'captions.import').map((l) => l.result.captions);
  const seqs = JSON.parse(sh(fc, ['inspect', 'sequence', '--project', proj, '--compact']).stdout);
  return { project: proj, seqV, captions, markers: seqs.markers.length, tracks: { video: seqs.video.map((t) => t.name), audio: seqs.audio.map((t) => `${t.name} (${t.items.length} clip${t.items.length === 1 ? '' : 's'})`) } };
}

/** Exports the vertical sequence from FilmCraft and compares it with the ffmpeg-muxed MP4. */
function roundTrip(fc, id, dir, seqV, cues, work) {
  const mine = join(dir, `${id}-vertical.mp4`);
  const theirs = join(dir, `${id}-vertical-filmcraft.mp4`);
  rmSync(theirs, { force: true });
  const t0 = Date.now();
  fcRun(fc, [{ id: 'file.exportMedia', params: { path: theirs, format: 'h264', sequence: seqV, bitrateMode: 'crf', crf: 18, audioCodec: 'aac', wait: true } }], work, 'fc-export', join(dir, `${id}.fcproj`));
  const seconds = (Date.now() - t0) / 1000;
  const [a, b] = [probe(mine), probe(theirs)];
  const ssim = (shift) => {
    const err = sh('ffmpeg', ['-hide_banner', '-nostats', '-i', mine, '-i', theirs, '-lavfi', `[0:v]trim=start_frame=${shift},setpts=PTS-STARTPTS[a];[a][1:v]ssim`, '-f', 'null', '-']).stderr;
    return Number(err.match(/All:([\d.]+)/)?.[1]);
  };
  const psnr = Number(sh('ffmpeg', ['-hide_banner', '-nostats', '-i', mine, '-i', theirs, '-lavfi', 'psnr', '-f', 'null', '-']).stderr.match(/average:([\d.inf]+)/)?.[1]);
  const [pa, pb] = [pcm(mine, SYNC_BAND), pcm(theirs, SYNC_BAND)];
  return {
    file: theirs,
    exportSeconds: Number(seconds.toFixed(1)),
    duration: { ffmpeg: a.duration, filmcraft: b.duration, videoFrames: [a.video.frames, b.video.frames], audio: [a.audio.duration, b.audio.duration] },
    audioLagSamples: syncPoints(cues, a.duration, pa).map((t) => lag(pa, pb, t)),
    ssim: { aligned: ssim(0), shiftedOneFrame: ssim(1) },
    psnr,
    loudness: ebur128(theirs),
    sizeMB: Number((readFileSync(theirs).length / 1e6).toFixed(1)),
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const o = args(process.argv.slice(2));
  const { parse } = await import('yaml');
  const all = (parse(readFileSync(o.file, 'utf8')).videos || []).map((v) => v.id);
  const ids = o.video || all.filter((id) => existsSync(join(o.in, `${id}-vertical.mp4`)) || existsSync(join(o.in, `${id}-landscape.mp4`)));
  if (!ids.length) throw new Error(`no rendered MP4s for ${o.file} in ${o.in}`);
  const fcExport = o.fcExport === 'none' ? null : o.fcExport || ids[0];

  log('tools');
  const sc = tool('soundcraft', o.fetchTools);
  const fc = o.filmcraft ? tool('filmcraft', o.fetchTools) : null;
  log(`  soundcraft: ${sc}\n  filmcraft:  ${fc || 'skipped'}`);

  const work = join(o.out, '.work');
  mkdirSync(work, { recursive: true });
  log(`timelines for ${ids.join(', ')}`);
  const tdir = timelines(o, ids, work);

  const summary = [];
  for (const id of ids) {
    log(`${id}`);
    const dir = join(o.out, id);
    mkdirSync(dir, { recursive: true });
    const timeline = JSON.parse(readFileSync(join(tdir, `${id}.timeline.json`), 'utf8'));
    const vtt = join(o.in, `${id}.vtt`);
    if (readFileSync(vtt, 'utf8') !== readFileSync(join(tdir, `${id}.vtt`), 'utf8')) throw new Error(`${id}: ${vtt} differs from the script's captions now; re-render before finishing`);
    const raw = join(o.cache, 'build', `${id}-narration.wav`);
    const rawInfo = probe(raw);
    if (Math.abs(rawInfo.duration - timeline.duration) > 0.001) throw new Error(`${id}: ${raw} is ${rawInfo.duration} s, the timeline ${timeline.duration} s; re-render`);
    const formats = ['vertical', 'landscape'].filter((f) => existsSync(join(o.in, `${id}-${f}.mp4`)));
    const marks = markers(timeline);
    const cues = marks.filter((m) => m.kind === 'cue');

    // 1. SoundCraft pass.
    const p = polish(o, sc, id, raw, dir, work);
    const outInfo = probe(p.out);
    const rawPcm = pcm(raw);
    const pts = syncPoints(cues, timeline.duration, rawPcm);
    const rawLow = pcm(raw, SYNC_BAND);
    const audio = {
      before: { soundcraft: p.before, ffmpeg: ebur128(raw) },
      passes: p.passes,
      after: { soundcraft: { lufs: p.report.lufs, truePeak: p.report.true_peak_db, samplePeak: p.report.peak_db }, ffmpeg: ebur128(p.out) },
      samples: { raw: Math.round(rawInfo.audio.samples), processed: Math.round(outInfo.audio.samples) },
      lagSamples: pts.map((t) => lag(rawLow, pcm(p.out, SYNC_BAND), t)),
      deEsser: p.deEss,
    };
    if (audio.samples.raw !== audio.samples.processed) throw new Error(`${id}: processed narration has ${audio.samples.processed} samples, raw ${audio.samples.raw}`);
    if (audio.lagSamples.some((l) => l.lag !== 0)) throw new Error(`${id}: processed narration is shifted: ${JSON.stringify(audio.lagSamples)}`);

    // 2. Replace the audio in each MP4, video copied.
    const mp4 = {};
    for (const f of formats) {
      const src = join(o.in, `${id}-${f}.mp4`);
      const dst = join(dir, `${id}-${f}.mp4`);
      mux(src, p.out, dst);
      const [a, b] = [probe(src), probe(dst)];
      const pb = pcm(dst);
      const lowB = pcm(dst, SYNC_BAND);
      const lastWord = timeline.segments.at(-1).audioStart + timeline.segments.at(-1).duration;
      const firstWord = timeline.segments[0].audioStart;
      let clipped = 0;
      for (const x of pb) if (Math.abs(x) >= 0.999) clipped++;
      mp4[f] = {
        duration: { before: a.duration, after: b.duration, video: [a.video.duration, b.video.duration], audio: [a.audio.duration, b.audio.duration], audioStart: [a.audio.start, b.audio.start] },
        videoStreamIdentical: videoHash(src) === videoHash(dst),
        lagVsRaw: pts.map((t) => lag(rawLow, lowB, t)),
        loudness: { before: { ffmpeg: ebur128(src), soundcraft: scMeasure(sc, src, work) }, after: { ffmpeg: ebur128(dst), soundcraft: scMeasure(sc, dst, work) } },
        listen: {
          clippedSamples: clipped,
          firstWordDb: { raw: rmsDb(rawPcm, firstWord, firstWord + 0.3), final: rmsDb(pb, firstWord, firstWord + 0.3) },
          lastWordDb: { raw: rmsDb(rawPcm, lastWord - 0.3, lastWord), final: rmsDb(pb, lastWord - 0.3, lastWord) },
          tailAfterLastWordS: Number((b.audio.duration - lastWord).toFixed(3)),
          cueWordsDb: pts.map((t) => rmsDb(pb, t, t + 0.4)),
        },
      };
      const m = mp4[f];
      const problems = [];
      if (!m.videoStreamIdentical) problems.push('video stream changed');
      if (Math.abs(m.duration.before - m.duration.after) > 0.001) problems.push('duration changed');
      if (Math.abs(m.duration.audio[0] - m.duration.audio[1]) > 0.001) problems.push('audio duration changed');
      if (m.lagVsRaw.some((l) => l.lag !== 0)) problems.push('audio shifted');
      if (m.loudness.after.ffmpeg.truePeak > o.truePeak) problems.push(`true peak ${m.loudness.after.ffmpeg.truePeak} dBTP`);
      if (Math.abs(m.loudness.after.ffmpeg.lufs - o.lufs) > 0.5) problems.push(`loudness ${m.loudness.after.ffmpeg.lufs} LUFS`);
      if (clipped) problems.push(`${clipped} clipped samples`);
      if (m.listen.lastWordDb.final < -45 || m.listen.firstWordDb.final < -45) problems.push('first or last word quiet: truncated?');
      if (problems.length) throw new Error(`${id}-${f}: ${problems.join(', ')}`);
      log(`  ${f}: ${m.loudness.before.ffmpeg.lufs} -> ${m.loudness.after.ffmpeg.lufs} LUFS, true peak ${m.loudness.after.ffmpeg.truePeak} dBTP, ${b.duration.toFixed(3)} s, video stream identical`);
    }
    copyFileSync(vtt, join(dir, `${id}.vtt`));
    if (existsSync(join(o.in, `${id}-landscape.jpg`))) copyFileSync(join(o.in, `${id}-landscape.jpg`), join(dir, `${id}-landscape.jpg`));

    // 3. FilmCraft hand-off.
    let handoff = null;
    if (fc) {
      handoff = filmcraft(fc, id, dir, timeline, marks, work);
      handoff.markersFromTimeline = { pageBreaks: marks.length - cues.length, cueWords: cues.length };
      if (id === fcExport) handoff.roundTrip = roundTrip(fc, id, dir, handoff.seqV, cues, work);
      log(`  filmcraft: ${handoff.project} (${handoff.markers} markers, ${handoff.captions.join('/')} captions)`);
    }
    const report = { id, duration: timeline.duration, narration: audio, mp4, filmcraft: handoff };
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 1));
    summary.push(report);
  }
  rmSync(work, { recursive: true, force: true });
  writeFileSync(join(o.out, 'report.json'), JSON.stringify(summary, null, 1));
  log('\nid                          narration raw -> polished   MP4 before -> after (LUFS / dBTP)');
  for (const r of summary) {
    const m = r.mp4.vertical || r.mp4.landscape;
    log(`${r.id.padEnd(28)}${r.narration.before.soundcraft.lufs.toFixed(1)} -> ${r.narration.after.soundcraft.lufs.toFixed(1)}          ${m.loudness.before.ffmpeg.lufs} / ${m.loudness.before.ffmpeg.truePeak} -> ${m.loudness.after.ffmpeg.lufs} / ${m.loudness.after.ffmpeg.truePeak}`);
  }
  log(`\nwrote ${o.out}`);
}

main().catch((e) => {
  log(`finish: ${e.message}`);
  process.exit(1);
});
