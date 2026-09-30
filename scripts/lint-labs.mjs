#!/usr/bin/env node
// Publish-time lints for lab directories.
//
//   node scripts/lint-labs.mjs [dir...]
//
// No arguments: every labs/*/ that has a manifest.yaml (labs/_shared is
// skipped). Exits 1 if any finding is an error. Warnings never fail the run.
//
// Library use: `lintLab(dir) -> { errors: Finding[], warnings: Finding[] }`
// with Finding = { rule, file, line, message }. This only READS the lab.
//
// Rules: leak, python-no-B, port-kill, port, hints-duplicate, brief-length,
// pressure-undisclosed, harness-stale-lock. See "Lint" in docs/lab-authoring.md.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineCounter, parseDocument } from 'yaml';

/** Canonical service ports (service name -> ports). Anything else on the port rule is a warning. */
export const CANONICAL_PORTS = {
  postgres: [5432],
  litellm: [4000],
  'litellm-grader': [4100],
  provider: [8961],
  view: [8962],
  'fault-proxy': [8963],
  contextforge: [4744],
  jaeger: [16686],
  otelcol: [4317, 4318],
  grafana: [3001],
  prometheus: [9090],
  qdrant: [6333, 6334],
  phoenix: [6006],
  mlflow: [5000],
};

const CANONICAL_PORT_SET = new Set(Object.values(CANONICAL_PORTS).flat());

const MAX_TEXT_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(['.git', '__pycache__', '.pytest_cache', '.ruff_cache']);

const LEAK_PATTERNS = [
  { label: 'TODO(you)', re: /TODO\(you\)/ },
  { label: 'TODO', re: /TODO/ },
  { label: 'the bug', re: /the bug/i },
  { label: 'to fix', re: /to fix/i },
  { label: "That's the function", re: /That's the function/ },
];

// Data files hold the lab's fictional world (customer messages, logs, cases):
// ordinary prose there says "to fix" or "the bug" without leaking anything, so
// they are only checked for TODO.
const DATA_EXTENSIONS = new Set(['.json', '.jsonl', '.csv', '.tsv', '.log', '.txt']);
const isDataFile = (file) => DATA_EXTENSIONS.has(extname(file).toLowerCase());

/** Every regular file under `dir` (symlinks are not followed), sorted. */
function walkFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** File contents as text, or null for a binary (NUL byte in the first 8 KB) or a file over 512 KB. */
function readText(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (st.size > MAX_TEXT_BYTES) return null;
  const buf = readFileSync(file);
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8');
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// ---------------------------------------------------------------- manifest

/** Parses manifest.yaml keeping source positions. Returns null when absent or unparseable (reported as a finding by the caller). */
function loadManifest(dir) {
  const file = join(dir, 'manifest.yaml');
  if (!existsSync(file)) return { file, doc: null, data: null, lc: null, error: 'no manifest.yaml' };
  const src = readFileSync(file, 'utf8');
  const lc = new LineCounter();
  const doc = parseDocument(src, { lineCounter: lc });
  if (doc.errors.length > 0) {
    return { file, doc, data: null, lc, error: doc.errors[0].message.split('\n')[0] };
  }
  const data = doc.toJS();
  return { file, doc, data: data && typeof data === 'object' ? data : {}, lc, error: null };
}

/** 1-based line of the node at `path` (falls back to the parent, then 1). */
function manifestLine(m, path) {
  for (let n = path.length; n >= 0; n--) {
    const node = m.doc.getIn(path.slice(0, n), true);
    const off = node && node.range ? node.range[0] : undefined;
    if (off !== undefined) return m.lc.linePos(off).line;
  }
  return 1;
}

// ------------------------------------------------------------------- rules

function ruleLeak(dir, add) {
  const wsDir = join(dir, 'workspace');
  for (const file of walkFiles(wsDir)) {
    const text = readText(file);
    if (text === null) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const patterns = isDataFile(file) ? LEAK_PATTERNS.filter((p) => p.label.startsWith('TODO')) : LEAK_PATTERNS;
      const hits = patterns.filter((p) => p.re.test(line)).map((p) => p.label);
      // "TODO(you)" also matches "TODO"; report the more specific one only.
      const labels = hits.includes('TODO(you)') ? hits.filter((h) => h !== 'TODO') : hits;
      if (labels.length === 0) return;
      add('error', 'leak', file, i + 1, `workspace file gives the solution away or is unfinished (${labels.map((l) => `"${l}"`).join(', ')}); learners can read everything under workspace/`);
    });
  }
}

/** Joins `\`-continued lines; each logical line keeps the number of its first physical line. */
function logicalLines(text) {
  const raw = text.split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    const start = i + 1;
    while (/\\\s*$/.test(line) && i + 1 < raw.length) {
      line = line.replace(/\\\s*$/, ' ') + raw[++i];
    }
    out.push({ text: line, line: start });
  }
  return out;
}

/** Blanks out quoted text that cannot hold a command (single quotes; double quotes other than a lone "$VAR" or one holding $(), so `echo "no python3 here"` is not an invocation. */
function stripQuoted(line) {
  return line
    .replace(/'[^']*'/g, (q) => ' '.repeat(q.length))
    .replace(/"[^"`]*"/g, (q) => (q.includes('$(') || /^"\$\{?\w+\}?"$/.test(q) ? q : ' '.repeat(q.length)));
}

/** Names of shell variables that hold a python interpreter (PY="$(command -v python3 || ...)", PY=python3). */
function pythonVars(text) {
  const vars = new Set();
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(line);
    if (!m) continue;
    if (/(?:command\s+-v|which)\s+python/.test(m[2]) || /^["']?python3?["']?\s*(?:#.*)?$/.test(m[2])) vars.add(m[1]);
  }
  return vars;
}

const CMD_PREFIX = String.raw`(?:^|[;&|(\x60]|\b(?:exec|then|do|else|sudo|nohup|time|timeout\s+\S+|env(?:\s+\w+=\S*)*))\s*`;

/** Every python invocation on the (quote-stripped) line: the literal interpreter, or a variable known to hold one. */
function pythonInvocations(line, vars) {
  const found = [];
  const lit = /(?:^|[\s/(\x60;&|])(python3?)(?=\s|$)/g;
  let m;
  while ((m = lit.exec(line))) found.push({ name: m[1], end: m.index + m[0].length });
  for (const v of vars) {
    const re = new RegExp(`${CMD_PREFIX}"?\\$\\{?${v}\\}?"?(?=\\s|$)`, 'g');
    while ((m = re.exec(line))) found.push({ name: `$${v} (python)`, end: m.index + m[0].length });
  }
  return found;
}

/** True when the python invocation whose text follows the interpreter carries -B (alone or in a short-flag cluster). */
function hasDashB(rest) {
  const cut = rest.split(/[|;&<>)`]/)[0] ?? '';
  const tokens = cut.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-' || !t.startsWith('-')) return false; // first script/arg: option parsing is over
    if (t.startsWith('--')) continue;
    if (/^-[A-Za-z]*B/.test(t)) return true; // -B, -uB, -BE ...
    if (t === '-W' || t === '-X') i++; // takes a separate argument
    if (/^-[A-Za-z]*[mc]$/.test(t)) return false; // -m mod / -c code: the rest belongs to the program
  }
  return false;
}

function rulePythonNoB(dir, add) {
  for (const file of walkFiles(join(dir, 'checks'))) {
    if (!file.endsWith('.sh')) continue;
    const text = readText(file);
    if (text === null) continue;
    const vars = pythonVars(text);
    for (const { text: raw, line: n } of logicalLines(text)) {
      if (/^\s*#/.test(raw)) continue;
      const line = stripQuoted(raw);
      if (/\b(?:command\s+-v|which|type|hash)\s+python/.test(line)) continue; // a lookup, not an invocation
      for (const inv of pythonInvocations(line, vars)) {
        // stripQuoted keeps offsets, so the flags are read from the original text.
        if (!hasDashB(raw.slice(inv.end))) {
          add('error', 'python-no-B', file, n, `${inv.name} invoked without -B; the check would leave __pycache__ in /workspace, which shadows the learner's edited source`);
          break;
        }
      }
    }
  }
}

function rulePortKill(dir, add) {
  for (const file of walkFiles(join(dir, 'checks'))) {
    const text = readText(file);
    if (text === null) continue;
    text.split('\n').forEach((line, i) => {
      if (/\bfuser\b[^\n]*\s-[A-Za-z]*k/.test(line)) {
        add('error', 'port-kill', file, i + 1, '`fuser -k` kills whatever holds the port, including the learner\'s own process; check the port, do not free it');
      }
      if (/\bpkill\b[^\n]*\s-[A-Za-z]*f/.test(line)) {
        add('error', 'port-kill', file, i + 1, '`pkill -f` matches full command lines and can kill the learner\'s processes (or the check itself); do not kill from a check');
      }
    });
  }
}

function isBarePortKey(key) {
  return /(^|_)PORT(_|$)/i.test(key);
}

function rulePort(m, add) {
  const data = m.data;
  const hasExempt = Object.prototype.hasOwnProperty.call(data, 'x-ports-exempt');
  if (hasExempt) {
    const reason = data['x-ports-exempt-reason'];
    if (typeof reason !== 'string' || reason.trim() === '') {
      add('error', 'port', m.file, manifestLine(m, ['x-ports-exempt']), 'x-ports-exempt requires a non-empty x-ports-exempt-reason string saying why this lab needs non-canonical ports');
    }
    if (data['x-ports-exempt'] === true) return;
  }

  const services = Array.isArray(data.services) ? data.services : [];
  const warn = (path, what, port, svcName) => {
    if (CANONICAL_PORT_SET.has(port)) return;
    const who = svcName ? `service "${svcName}"` : 'the manifest env';
    add('warning', 'port', m.file, manifestLine(m, path), `${who} ${what} ${port}, which is not in the canonical port table (set x-ports-exempt: true with x-ports-exempt-reason to silence)`);
  };

  const envPorts = (env, basePath, svcName) => {
    if (!env || typeof env !== 'object') return;
    for (const [k, v] of Object.entries(env)) {
      const s = String(v).trim();
      if (!/^\d{1,5}$/.test(s) || !isBarePortKey(k)) continue;
      const port = Number(s);
      if (port < 1 || port > 65535) continue;
      warn([...basePath, k], `sets env ${k} to`, port, svcName);
    }
  };

  envPorts(data.env, ['env'], null);
  services.forEach((svc, i) => {
    if (!svc || typeof svc !== 'object') return;
    const name = typeof svc.name === 'string' ? svc.name : `#${i}`;
    if (typeof svc.port === 'number') warn(['services', i, 'port'], 'listens on port', svc.port, name);
    envPorts(svc.env, ['services', i, 'env'], name);
  });
}

function normaliseWithMap(text) {
  let out = '';
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      map.push(i);
      pendingSpace = false;
    }
    out += text[i];
    map.push(i);
  }
  return { text: out, map };
}

function ruleHintsDuplicate(dir, m, add) {
  const file = join(dir, 'hints.md');
  if (!existsSync(file)) return;
  const raw = readText(file);
  if (raw === null) return;
  const norm = normaliseWithMap(raw);
  const hints = Array.isArray(m.data.hints) ? m.data.hints : [];
  hints.forEach((h, i) => {
    if (!h || typeof h.text !== 'string') return;
    const prefix = normaliseWithMap(h.text).text.slice(0, 40);
    if (prefix === '') return;
    const at = norm.text.indexOf(prefix);
    if (at === -1) return;
    add('error', 'hints-duplicate', file, lineOf(raw, norm.map[at]), `hints.md repeats the start of manifest hints[${i}] ("${prefix}"); hints.md ships to /workspace at minute zero, so the timed hint is no longer gated`);
  });
}

function ruleBrief(dir, m, add) {
  const file = join(dir, 'brief.md');
  const raw = existsSync(file) ? readText(file) : null;

  if (raw !== null) {
    let inFence = null;
    let words = 0;
    for (const line of raw.split('\n')) {
      const fence = /^\s*(```+|~~~+)/.exec(line);
      if (fence) {
        if (inFence === null) inFence = fence[1][0];
        else if (fence[1][0] === inFence) inFence = null;
        continue;
      }
      if (inFence !== null) continue;
      words += line.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    }
    if (words > 700) add('error', 'brief-length', file, 1, `brief.md is ${words} words (limit 700, target 500); code blocks not counted`);
    else if (words > 500) add('warning', 'brief-length', file, 1, `brief.md is ${words} words (target 500, error above 700); code blocks not counted`);
  }

  const pressure = Array.isArray(m.data.pressure) ? m.data.pressure : [];
  if (pressure.length > 0 && !(raw !== null && /minute/i.test(raw))) {
    add('error', 'pressure-undisclosed', existsSync(file) ? file : m.file, existsSync(file) ? 1 : manifestLine(m, ['pressure']),
      `manifest has ${pressure.length} pressure event${pressure.length === 1 ? '' : 's'} but brief.md ${raw === null ? 'is missing' : 'never says "minute"'}; the brief must tell the learner something will happen and roughly when`);
  }
}

function ruleHarnessStaleLock(dir, add) {
  const file = join(dir, 'checks', '_harness.py');
  if (!existsSync(file)) return;
  const text = readText(file);
  if (text === null) return;
  const ref = /results\.lock|\.lock\b/.exec(text);
  if (!ref) return;
  const stale = /getmtime|st_mtime/.test(text);
  const guarded = /\btry:/.test(text) && /except\s+Exception/.test(text);
  if (stale && guarded) return;
  const missing = [];
  if (!stale) missing.push('a staleness check (os.path.getmtime / st_mtime)');
  if (!guarded) missing.push('a try:/except Exception around main');
  add('warning', 'harness-stale-lock', file, lineOf(text, ref.index), `_harness.py uses a lock file (${ref[0]}) but is missing ${missing.join(" and ")}; a crashed run can leave the lock and fail every later run`);
}

// --------------------------------------------------------------------- API

/**
 * @param {string} dir a lab directory (containing manifest.yaml)
 * @returns {{errors: Array<{rule:string,file:string,line:number,message:string}>, warnings: Array<{rule:string,file:string,line:number,message:string}>}}
 */
export function lintLab(dir) {
  const errors = [];
  const warnings = [];
  const add = (severity, rule, file, line, message) => {
    (severity === 'error' ? errors : warnings).push({ rule, file, line, message });
  };

  ruleLeak(dir, add);
  rulePythonNoB(dir, add);
  rulePortKill(dir, add);
  ruleHarnessStaleLock(dir, add);

  const m = loadManifest(dir);
  if (m.error) {
    // Rules that need the manifest cannot run; the publish path reports a missing/bad manifest itself.
    if (m.doc) add('error', 'manifest', m.file, 1, `manifest.yaml does not parse: ${m.error}`);
  } else {
    rulePort(m, add);
    ruleHintsDuplicate(dir, m, add);
    ruleBrief(dir, m, add);
  }

  const byPos = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  errors.sort(byPos);
  warnings.sort(byPos);
  return { errors, warnings };
}

/** Every labs/*\/ with a manifest.yaml under `labsRoot`, excluding _shared. */
export function discoverLabs(labsRoot) {
  if (!existsSync(labsRoot)) return [];
  return readdirSync(labsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_shared' && existsSync(join(labsRoot, e.name, 'manifest.yaml')))
    .map((e) => join(labsRoot, e.name))
    .sort();
}

export function formatFinding(f, severity) {
  return `${f.file}:${f.line}: ${severity} ${f.rule}: ${f.message}`;
}

/**
 * Lints each dir, prints one line per finding and a summary via `log`.
 * @returns {{errors: number, warnings: number, labs: number}}
 */
export function lintAndReport(dirs, log = console.log) {
  let errors = 0;
  let warnings = 0;
  for (const dir of dirs) {
    const r = lintLab(dir);
    for (const f of r.errors) log(formatFinding(f, 'error'));
    for (const f of r.warnings) log(formatFinding(f, 'warning'));
    errors += r.errors.length;
    warnings += r.warnings.length;
  }
  log(`lint-labs: ${dirs.length} lab${dirs.length === 1 ? '' : 's'} checked, ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
  return { errors, warnings, labs: dirs.length };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const dirs = args.length > 0 ? args : discoverLabs(relative(process.cwd(), join(root, 'labs')) || 'labs');
  const bad = dirs.filter((d) => !existsSync(d) || !lstatSync(d).isDirectory());
  if (bad.length > 0) {
    console.error(`lint-labs: not a directory: ${bad.join(', ')}`);
    process.exit(2);
  }
  const { errors } = lintAndReport(dirs);
  process.exit(errors > 0 ? 1 : 0);
}
