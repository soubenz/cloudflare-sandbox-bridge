import { describe, it, expect } from 'vitest';

/**
 * What the editor's file tree leaves out (dashboard/src/file-tree.js): brief.md and hints.md on every
 * lab, plus the manifest's `hidden` paths, and any folder that has nothing left to show. Pure module;
 * the folder listing is a stub here.
 */
type Entry = { name: string; isDirectory: boolean; size?: number };
type Rules = { files: Set<string>; folders: string[] };
const T = (await import('../../dashboard/src/file-tree.js' as string)) as {
  ALWAYS_HIDDEN: string[];
  hiddenRules: (hidden?: unknown) => Rules;
  isHidden: (rules: Rules, path: string) => boolean;
  visibleEntries: (rules: Rules, dir: string, entries: Entry[], listDir: (rel: string) => Promise<Entry[]>) => Promise<Entry[]>;
};

/** A workspace as a map of file paths; folders are implied. Returns a listDir and the folders it was asked for. */
function workspace(paths: string[]) {
  const asked: string[] = [];
  const list = (dir: string): Entry[] => {
    const prefix = dir ? `${dir}/` : '';
    const seen = new Map<string, Entry>();
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const [name, ...rest] = p.slice(prefix.length).split('/');
      if (name) seen.set(name, { name, isDirectory: rest.length > 0 || p.endsWith('/') });
    }
    return [...seen.values()];
  };
  const listDir = async (dir: string) => {
    asked.push(dir);
    if (dir === 'unreadable') throw new Error('403');
    return list(dir);
  };
  return { root: list(''), list, listDir, asked };
}
const names = (entries: Entry[]) => entries.map((e) => e.name).sort();

const GATEWAY_LAB = ['brief.md', 'answers.json', 'send_calls.py', 'gateway/config.yaml', 'services/fake_provider.py', 'services/view_service.py'];

describe('the platform default: brief.md and hints.md', () => {
  it('are left out of the top of the workspace on every lab, with no manifest entry', async () => {
    expect(T.ALWAYS_HIDDEN).toEqual(['brief.md', 'hints.md']);
    const ws = workspace(['brief.md', 'hints.md', 'answers.json', 'app.py']);
    for (const hidden of [undefined, null, [], 'not a list']) {
      expect(names(await T.visibleEntries(T.hiddenRules(hidden), '', ws.root, ws.listDir))).toEqual(['answers.json', 'app.py']);
    }
  });

  it('only at the top: a brief.md the lab keeps in a folder of its own is still shown', async () => {
    const rules = T.hiddenRules();
    expect(T.isHidden(rules, 'brief.md')).toBe(true);
    expect(T.isHidden(rules, 'hints.md')).toBe(true);
    expect(T.isHidden(rules, 'docs/brief.md')).toBe(false);
    expect(T.isHidden(rules, 'answers.json')).toBe(false);
  });
});

describe('hiddenRules and isHidden', () => {
  it('reads a trailing slash as a whole folder, and anything else as one file', () => {
    const rules = T.hiddenRules(['services/', 'view.py', 'gateway/seed.py']);
    expect(T.isHidden(rules, 'services')).toBe(true);
    expect(T.isHidden(rules, 'services/fake_provider.py')).toBe(true);
    expect(T.isHidden(rules, 'services/deep/x.py')).toBe(true);
    expect(T.isHidden(rules, 'services-old/x.py')).toBe(false);
    expect(T.isHidden(rules, 'view.py')).toBe(true);
    expect(T.isHidden(rules, 'gateway/view.py')).toBe(false);
    expect(T.isHidden(rules, 'gateway/seed.py')).toBe(true);
    expect(T.isHidden(rules, 'gateway')).toBe(false);
    expect(T.isHidden(rules, 'gateway/config.yaml')).toBe(false);
  });

  it('ignores entries the schema would refuse instead of trusting them', () => {
    const rules = T.hiddenRules(['/workspace/app.py', '../x', '', 'a//b', 42, './ok.py']);
    expect([...rules.files].sort()).toEqual(['brief.md', 'hints.md', 'ok.py']);
    expect(rules.folders).toEqual([]);
  });
});

describe('visibleEntries', () => {
  it('shows see-what-a-gateway-does without its services/ folder', async () => {
    const ws = workspace(GATEWAY_LAB);
    const shown = await T.visibleEntries(T.hiddenRules(['services/']), '', ws.root, ws.listDir);
    expect(names(shown)).toEqual(['answers.json', 'gateway', 'send_calls.py']);
    // A hidden folder is dropped by its name: nothing inside it is listed to decide that.
    expect(ws.asked).toEqual([]);
  });

  it('drops a folder whose every file is hidden one by one, and keeps one with something left', async () => {
    const ws = workspace(GATEWAY_LAB);
    const rules = T.hiddenRules(['services/fake_provider.py', 'services/view_service.py', 'gateway/seed.py']);
    expect(names(await T.visibleEntries(rules, '', ws.root, ws.listDir))).toEqual(['answers.json', 'gateway', 'send_calls.py']);
    // Only the folders with something hidden inside were listed to find out.
    expect(ws.asked.sort()).toEqual(['gateway', 'services']);

    const partly = T.hiddenRules(['services/fake_provider.py']);
    expect(names(await T.visibleEntries(partly, '', ws.root, ws.listDir))).toEqual(['answers.json', 'gateway', 'send_calls.py', 'services']);
    expect(names(await T.visibleEntries(partly, 'services', ws.list('services'), ws.listDir))).toEqual(['view_service.py']);
  });

  it('follows nested folders down to decide whether anything is left', async () => {
    const ws = workspace(['app.py', 'gateway/hooks/seed.py', 'gateway/hooks/guard.py']);
    expect(names(await T.visibleEntries(T.hiddenRules(['gateway/hooks/seed.py']), '', ws.root, ws.listDir))).toEqual(['app.py', 'gateway']);
    expect(names(await T.visibleEntries(T.hiddenRules(['gateway/hooks/']), '', ws.root, ws.listDir))).toEqual(['app.py']);
    expect(names(await T.visibleEntries(T.hiddenRules(['gateway/hooks/', 'gateway/x/']), 'gateway', ws.list('gateway'), ws.listDir))).toEqual([]);
  });

  it('keeps a folder it cannot list rather than lose the files in it', async () => {
    const ws = workspace(['unreadable/a.py', 'app.py']);
    expect(names(await T.visibleEntries(T.hiddenRules(['unreadable/b.py']), '', ws.root, ws.listDir))).toEqual(['app.py', 'unreadable']);
  });

  it('leaves an empty folder the lab ships alone when nothing in it is hidden', async () => {
    const ws = workspace(['out/', 'app.py']);
    expect(names(await T.visibleEntries(T.hiddenRules(['view.py']), '', ws.root, ws.listDir))).toEqual(['app.py', 'out']);
    expect(ws.asked).toEqual([]);
  });

  it('keeps each entry as the listing gave it', async () => {
    const entries = [{ name: 'app.py', isDirectory: false, size: 12 }];
    expect(await T.visibleEntries(T.hiddenRules(), '', entries, async () => [])).toEqual(entries);
  });
});
