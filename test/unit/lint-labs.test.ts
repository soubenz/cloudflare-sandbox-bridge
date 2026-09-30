import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Finding {
  rule: string;
  file: string;
  line: number;
  message: string;
}
interface LintResult {
  errors: Finding[];
  warnings: Finding[];
}
type LintLab = (dir: string) => LintResult;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let lintLab: LintLab;
let tmp: string;
let counter = 0;

beforeAll(async () => {
  // Computed specifier: the .mjs has no types and allowJs is off.
  const mod = await import(pathToFileURL(join(repoRoot, 'scripts', 'lint-labs.mjs')).href);
  lintLab = mod.lintLab as LintLab;
  tmp = mkdtempSync(join(tmpdir(), 'lint-labs-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// `services:` is last so a test can append more service entries, then top-level keys.
const BASE_MANIFEST = `slug: fixture-lab
version: 1.0.0
title: "Fixture"
type: break-fix
family: agent
timeout_minutes: 60
checks:
  - name: works
    script: works.sh
services:
  - name: agent
    argv: ["python3", "-B", "agent.py"]
`;

/** Builds a lab directory from a map of relative path -> contents (or Buffer). */
function lab(files: Record<string, string | Buffer> = {}): string {
  const dir = join(tmp, `lab-${counter++}`);
  const all = { 'manifest.yaml': BASE_MANIFEST, 'brief.md': 'Fix the agent.\n', ...files };
  for (const [rel, content] of Object.entries(all)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const rules = (fs: Finding[]) => fs.map((f) => f.rule);
const manifest = (extra: string) => BASE_MANIFEST + extra;

describe('lintLab: clean lab', () => {
  it('reports nothing for a compliant lab', () => {
    const r = lintLab(lab({ 'workspace/agent.py': 'print("hi")\n', 'checks/works.sh': 'exec python3 -B "$(dirname "$0")/x.py"\n' }));
    expect(r).toEqual({ errors: [], warnings: [] });
  });
});

describe('leak', () => {
  it.each([
    ['TODO: finish', 'TODO'],
    ['# TODO(you): write this', 'TODO(you)'],
    ['# this is The Bug', 'the bug'],
    ['# you need To Fix this', 'to fix'],
    ["# That's the function to change", "That's the function"],
  ])('flags %j in workspace/', (line, label) => {
    const r = lintLab(lab({ 'workspace/app/main.py': `x = 1\n${line}\n` }));
    expect(rules(r.errors)).toContain('leak');
    const f = r.errors.find((e) => e.rule === 'leak')!;
    expect(f.line).toBe(2);
    expect(f.file.endsWith(join('workspace', 'app', 'main.py'))).toBe(true);
    expect(f.message).toContain(label);
  });

  it('reports TODO(you) once, not also as TODO', () => {
    const r = lintLab(lab({ 'workspace/a.py': '# TODO(you)\n' }));
    expect(r.errors.filter((e) => e.rule === 'leak')).toHaveLength(1);
  });

  it('does not flag clean workspace files, or the phrases outside workspace/', () => {
    const r = lintLab(
      lab({
        'workspace/a.py': 'def f():\n    return 1\n',
        'brief.md': 'TODO and the bug are fine in the brief\n',
        'checks/works.sh': '# TODO the bug to fix\n',
        'solution/a.py': '# TODO\n',
      })
    );
    expect(rules(r.errors)).not.toContain('leak');
  });

  it('checks data files for TODO only, so fictional prose may say "to fix"', () => {
    const prose = '{"text": "tell me which feed to fix first; the bug is in the import"}\n';
    const ok = lintLab(lab({ 'workspace/traffic.json': prose }));
    expect(rules(ok.errors)).not.toContain('leak');
    const bad = lintLab(lab({ 'workspace/traffic.json': '{"note": "TODO"}\n' }));
    expect(rules(bad.errors)).toContain('leak');
  });

  it('skips binaries and files over 512 KB', () => {
    const r = lintLab(
      lab({
        'workspace/blob.bin': Buffer.concat([Buffer.from('TODO'), Buffer.from([0, 1, 2])]),
        'workspace/big.txt': 'TODO\n' + 'x'.repeat(513 * 1024),
      })
    );
    expect(rules(r.errors)).not.toContain('leak');
  });
});

describe('python-no-B', () => {
  it('flags python3 and python without -B, including via a $PY variable', () => {
    const r = lintLab(
      lab({
        'checks/a.sh': 'python3 x.py\n',
        'checks/b.sh': 'python -u x.py\n',
        'checks/c.sh': 'PY="$(command -v python3 || true)"\nexec "$PY" x.py\n',
        'checks/d.sh': 'python3 -m pytest\n',
      })
    );
    const bad = r.errors.filter((e) => e.rule === 'python-no-B');
    expect(bad.map((e) => e.file.split('/').pop()).sort()).toEqual(['a.sh', 'b.sh', 'c.sh', 'd.sh']);
    expect(bad.find((e) => e.file.endsWith('c.sh'))!.line).toBe(2);
  });

  it('accepts -B, clustered flags, continuations, and lookups/quoted mentions', () => {
    const r = lintLab(
      lab({
        'checks/a.sh': 'python3 -B x.py\npython -uB x.py\n/usr/bin/python3 \\\n  -B y.py\n',
        'checks/b.sh': 'PY="$(command -v python3 || command -v python || true)"\necho "grader bug: no python3 on PATH"\nexec "$PY" -B x.py\n',
        'checks/c.sh': '# python3 without flags in a comment\nwhich python3 >/dev/null\n',
        'checks/notes.txt': 'python3 x.py\n', // only .sh is checked
      })
    );
    expect(rules(r.errors)).not.toContain('python-no-B');
  });
});

describe('port-kill', () => {
  it('flags fuser -k and pkill -f anywhere under checks/', () => {
    const r = lintLab(
      lab({
        'checks/a.sh': 'fuser -k 8080/tcp\n',
        'checks/sub/b.sh': 'pkill -9 -f agent.py\n',
        'checks/_harness.py': 'subprocess.run(["sh", "-c", "pkill -f agent"])\n',
      })
    );
    expect(r.errors.filter((e) => e.rule === 'port-kill')).toHaveLength(3);
  });

  it('accepts fuser without -k, pkill without -f, and files outside checks/', () => {
    const r = lintLab(lab({ 'checks/a.sh': 'fuser 8080/tcp\npkill agent\n', 'pressure/p.sh': 'pkill -f burst\n' }));
    expect(rules(r.errors)).not.toContain('port-kill');
  });
});

describe('port', () => {
  it('warns on a non-canonical service port and a bare-port env value, naming service and port', () => {
    const r = lintLab(
      lab({
        'manifest.yaml': manifest(`  - name: side
    argv: ["x"]
    port: 8970
    env:
      SIDE_PORT: "8971"
env:
  OTHER_PORT: "9999"
`),
      })
    );
    const w = r.warnings.filter((x) => x.rule === 'port');
    expect(w.map((x) => x.message).join('\n')).toMatch(/service "side" listens on port 8970/);
    expect(w.map((x) => x.message).join('\n')).toMatch(/service "side" sets env SIDE_PORT to 8971/);
    expect(w.map((x) => x.message).join('\n')).toMatch(/manifest env sets env OTHER_PORT to 9999/);
    expect(r.errors).toEqual([]);
    expect(w.every((x) => x.line > 1)).toBe(true);
  });

  it('accepts every canonical port, and non-port env numbers', () => {
    const ports = [5432, 4000, 4100, 8961, 8962, 8963, 4744, 16686, 4317, 4318, 3001, 9090, 6333, 6334, 6006, 5000];
    const services = ports.map((p, i) => `  - name: s${i}\n    argv: ["x"]\n    port: ${p}\n`).join('');
    const r = lintLab(lab({ 'manifest.yaml': manifest(services + 'env:\n  MAX_ATTEMPTS: "3"\n  DB_PORT: "5432"\n') }));
    expect(rules(r.warnings)).not.toContain('port');
  });

  it('x-ports-exempt: true with a reason silences the warning', () => {
    const r = lintLab(
      lab({ 'manifest.yaml': manifest('  - name: side\n    argv: ["x"]\n    port: 8970\nx-ports-exempt: true\nx-ports-exempt-reason: "needs two providers"\n') })
    );
    expect(r.errors).toEqual([]);
    expect(rules(r.warnings)).not.toContain('port');
  });

  it('x-ports-exempt without a reason is an error', () => {
    const r = lintLab(lab({ 'manifest.yaml': manifest('x-ports-exempt: true\n') }));
    expect(r.errors.map((e) => e.rule)).toEqual(['port']);
    expect(r.errors[0]!.message).toContain('x-ports-exempt-reason');
    const empty = lintLab(lab({ 'manifest.yaml': manifest('x-ports-exempt: true\nx-ports-exempt-reason: ""\n') }));
    expect(rules(empty.errors)).toEqual(['port']);
  });
});

describe('hints-duplicate', () => {
  const hinted = manifest(`hints:
  - after_minutes: 10
    text: "Look at the retry loop   in the mailer, it resends after a timeout."
`);

  it('flags hints.md repeating the first 40 chars of a hint, whitespace-normalised', () => {
    const r = lintLab(lab({ 'manifest.yaml': hinted, 'hints.md': '# Hints\n\nLook at the retry loop\nin the mailer, it resends after\nsomething else\n' }));
    expect(r.errors.map((e) => e.rule)).toEqual(['hints-duplicate']);
    expect(r.errors[0]!.line).toBe(3);
  });

  it('accepts a different hints.md, and a lab with no hints.md', () => {
    expect(rules(lintLab(lab({ 'manifest.yaml': hinted, 'hints.md': 'Read the logs.\n' })).errors)).not.toContain('hints-duplicate');
    expect(rules(lintLab(lab({ 'manifest.yaml': hinted })).errors)).not.toContain('hints-duplicate');
  });
});

describe('brief-length', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ') + '\n';

  it('warns above 500 words and errors above 700', () => {
    const w = lintLab(lab({ 'brief.md': words(501) }));
    expect(w.warnings.map((x) => x.rule)).toEqual(['brief-length']);
    expect(w.errors).toEqual([]);
    const e = lintLab(lab({ 'brief.md': words(701) }));
    expect(e.errors.map((x) => x.rule)).toEqual(['brief-length']);
    expect(e.warnings).toEqual([]);
  });

  it('accepts 500 words, and does not count fenced code blocks', () => {
    expect(lintLab(lab({ 'brief.md': words(500) }))).toEqual({ errors: [], warnings: [] });
    const fenced = words(100) + '```sh\n' + words(900) + '```\n' + words(100);
    expect(lintLab(lab({ 'brief.md': fenced }))).toEqual({ errors: [], warnings: [] });
  });
});

describe('pressure-undisclosed', () => {
  const pressured = manifest(`pressure:
  - id: burst
    at_minutes: 5
    argv: ["/opt/lab/pressure/burst.sh"]
    title: "Traffic triples"
    message: "Traffic tripled"
`);

  it('errors when the brief never says "minute"', () => {
    const r = lintLab(lab({ 'manifest.yaml': pressured, 'brief.md': 'Keep it up.\n' }));
    expect(r.errors.map((e) => e.rule)).toEqual(['pressure-undisclosed']);
  });

  it('accepts a brief that says minute (any case), and a lab with no pressure', () => {
    expect(lintLab(lab({ 'manifest.yaml': pressured, 'brief.md': 'Around Minute five, traffic changes.\n' })).errors).toEqual([]);
    expect(lintLab(lab({ 'manifest.yaml': manifest('pressure: []\n'), 'brief.md': 'No mention.\n' })).errors).toEqual([]);
  });
});

describe('harness-stale-lock', () => {
  it('warns when a lock file is used without a staleness check and try/except', () => {
    const r = lintLab(lab({ 'checks/_harness.py': 'LOCK = "/tmp/results.lock"\ndef main():\n    open(LOCK, "x")\n' }));
    expect(r.warnings.map((w) => w.rule)).toEqual(['harness-stale-lock']);
    expect(r.warnings[0]!.line).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('warns when only one of the two protections is present', () => {
    const onlyStale = 'import os\nLOCK="/tmp/results.lock"\nos.path.getmtime(LOCK)\n';
    expect(rules(lintLab(lab({ 'checks/_harness.py': onlyStale })).warnings)).toEqual(['harness-stale-lock']);
    const onlyTry = 'LOCK="/tmp/results.lock"\ntry:\n    main()\nexcept Exception:\n    pass\n';
    expect(rules(lintLab(lab({ 'checks/_harness.py': onlyTry })).warnings)).toEqual(['harness-stale-lock']);
  });

  it('accepts a harness with both, one without a lock, and no harness', () => {
    const good = 'import os\nLOCK="/tmp/results.lock"\nage = os.stat(LOCK).st_mtime\ntry:\n    main()\nexcept Exception:\n    pass\n';
    expect(lintLab(lab({ 'checks/_harness.py': good })).warnings).toEqual([]);
    expect(lintLab(lab({ 'checks/_harness.py': 'def main():\n    pass\n' })).warnings).toEqual([]);
    expect(lintLab(lab()).warnings).toEqual([]);
  });
});

describe('real labs', () => {
  it('lintLab runs on labs/duplicate-emails without throwing', () => {
    const r = lintLab(join(repoRoot, 'labs', 'duplicate-emails'));
    expect(Array.isArray(r.errors)).toBe(true);
    expect(Array.isArray(r.warnings)).toBe(true);
    for (const f of [...r.errors, ...r.warnings]) {
      expect(typeof f.rule).toBe('string');
      expect(typeof f.file).toBe('string');
      expect(f.line).toBeGreaterThanOrEqual(1);
      expect(typeof f.message).toBe('string');
    }
  });
});
