// node --test scripts/shorts/assets.test.mjs
// The asset manifest (scripts/shorts/page/assets/manifest.json) and how the renderer resolves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandElementIds, checkBrandBeats, loadManifest, manifestProblems, prepareSceneAssets, resolveAsset, trademarkLine } from './assets.mjs';
import { ICON_NAMES } from './page/canvas.js';

const real = loadManifest();

test('the real manifest is valid and its files are in place', () => {
  assert.deepEqual(manifestProblems(real, { dir: real.dir }), []);
});

test('every brand the videos discuss has a decision recorded', () => {
  for (const id of ['openai', 'chatgpt', 'anthropic', 'claude', 'mcp', 'github', 'cursor', 'docker', 'gemini', 'contextforge', 'cloudflare', 'kong', 'litellm', 'postgresql', 'jaeger', 'opentelemetry', 'grafana', 'qdrant', 'phoenix', 'python', 'nodejs']) {
    const a = real.byId.get(id);
    assert.ok(a, `no entry for ${id}`);
    assert.equal(a.kind, 'brand');
    assert.equal(typeof a.allowed, 'boolean');
  }
  for (const id of ['agent', 'server', 'database', 'key', 'lock', 'clock', 'calendar', 'cloud', 'weather', 'chat', 'terminal', 'document', 'warning', 'money']) {
    assert.equal(real.byId.get(id)?.kind, 'icon', id);
  }
});

const entry = (over = {}) => ({ id: 'x', name: 'X', kind: 'icon', file: 'icons/x.svg', allowed: true, owner: 'O', licence: 'ISC', source: 'pkg@1', color: 'theme', guidelines: null, rules: ['r'], ...over });
const mf = (assets) => ({ trademarkLine: 'Trademarks ({names}) belong to their owners.', assets });

test('manifestProblems catches a malformed manifest', () => {
  assert.deepEqual(manifestProblems(mf([entry()])), []);
  assert.match(manifestProblems(null)[0], /assets/);
  assert.match(manifestProblems({ assets: [] })[0], /trademarkLine/);
  assert.match(manifestProblems(mf([entry(), entry()])).join('\n'), /listed twice/);
  assert.match(manifestProblems(mf([entry({ kind: 'logo' })])).join('\n'), /kind must be brand or icon/);
  assert.match(manifestProblems(mf([entry({ allowed: 'yes' })])).join('\n'), /allowed must be true or false/);
  assert.match(manifestProblems(mf([entry({ file: null })])).join('\n'), /needs "file"/);
  assert.match(manifestProblems(mf([entry({ rules: [] })])).join('\n'), /needs "rules"/);
  assert.match(manifestProblems(mf([entry({ kind: 'brand', file: 'brands/x.svg', guidelines: null })])).join('\n'), /allowed brand needs the "guidelines"/);
  assert.match(manifestProblems(mf([entry({ kind: 'brand', file: 'brands/x.svg', guidelines: 'http://x' })])).join('\n'), /https URL/);
  assert.match(manifestProblems(mf([entry({ allowed: false })])).join('\n'), /keeps no file/);
  assert.match(manifestProblems(mf([entry({ allowed: false, file: null, rules: ['ok'] })])).join('\n'), /Do not use/);
  assert.deepEqual(manifestProblems(mf([entry({ allowed: false, file: null, rules: ['Do not use; write the name in text instead.'] })])), []);
});

test('manifestProblems checks the files: present, SVG, icons in currentColor, brands not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assets-'));
  try {
    mkdirSync(join(dir, 'icons'));
    mkdirSync(join(dir, 'brands'));
    writeFileSync(join(dir, 'icons/ok.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="currentColor"/>');
    writeFileSync(join(dir, 'icons/fixed.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="#000"/>');
    writeFileSync(join(dir, 'brands/b.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"/>');
    writeFileSync(join(dir, 'brands/s.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>1</script></svg>');
    const brand = (file) => entry({ id: file.replace(/\W/g, ''), kind: 'brand', file, guidelines: 'https://example.com/brand' });
    assert.deepEqual(manifestProblems(mf([entry({ file: 'icons/ok.svg' })]), { dir }), []);
    assert.match(manifestProblems(mf([entry({ file: 'icons/missing.svg' })]), { dir }).join('\n'), /missing/);
    assert.match(manifestProblems(mf([entry({ file: 'icons/fixed.svg' })]), { dir }).join('\n'), /currentColor so the theme/);
    assert.match(manifestProblems(mf([brand('brands/b.svg')]), { dir }).join('\n'), /permitted colours, not currentColor/);
    assert.match(manifestProblems(mf([brand('brands/s.svg')]), { dir }).join('\n'), /scripts/);
    assert.match(manifestProblems(mf([entry({ file: 'icons/../../x.svg' })]), { dir }).join('\n'), /outside the assets folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAsset refuses a missing, disallowed or wrong-kind asset', () => {
  assert.throws(() => resolveAsset(real, 'nope', { kind: 'brand', where: 'seg "a"' }), /seg "a": no brand "nope".*Usable brands: .*github/);
  assert.throws(() => resolveAsset(real, 'claude', { kind: 'brand' }), /"claude" \(Claude, Anthropic, PBC\) is not allowed .*write the name in text instead/);
  assert.throws(() => resolveAsset(real, 'chatgpt', { kind: 'brand' }), /not allowed/);
  assert.throws(() => resolveAsset(real, 'github', { kind: 'icon' }), /is a brand mark, not an icon: use `logo: github`/);
  assert.throws(() => resolveAsset(real, 'database', { kind: 'brand' }), /generic icon, not a brand mark/);
  const gh = resolveAsset(real, 'github', { kind: 'brand' });
  assert.equal(gh.name, 'GitHub');
  assert.match(gh.svg, /^<svg/);
  assert.equal(gh.aspect, 1);
});

test('prepareSceneAssets inlines marks and library icons, keeps built-ins, and names the brands', () => {
  const { elements, brands } = prepareSceneAssets({
    gh: { type: 'logo', id: 'github', pos: [1, 1] },
    py: { type: 'logo', id: 'python', label: 'Python 3.12' },
    chip: { type: 'chip', text: 'Kong', logo: 'kong' },
    agent: { type: 'node', icon: 'agent', label: 'Agent' },
    db: { type: 'node', icon: 'database', label: 'DB' },
    srv: { type: 'icon', icon: 'lib:server' },
    lock: { type: 'icon', id: 'lock', label: 'locked' },
    list: { type: 'list', items: ['plain', { text: 'GitHub', logo: 'github' }, { text: 'money', icon: 'money' }] },
    chat: { type: 'chat', title: 'ChatGPT', messages: [{ text: 'hi', side: 'right' }] },
  }, real, { builtin: ICON_NAMES, where: 'w' });
  assert.equal(elements.gh._mark.id, 'github');
  assert.equal(elements.gh.label, 'GitHub');
  assert.equal(elements.py.label, 'Python 3.12');
  assert.equal(elements.chip._mark.id, 'kong');
  assert.equal(elements.agent._icon, undefined); // built-in wins for a plain name
  assert.equal(elements.db._icon.id, 'database');
  assert.equal(elements.srv._icon.id, 'server');
  assert.equal(elements.lock._icon.id, 'lock');
  assert.equal(elements.list.items[0], 'plain');
  assert.equal(elements.list.items[1]._mark.id, 'github');
  assert.equal(elements.list.items[2]._icon.id, 'money');
  assert.equal(elements.chat.title, 'ChatGPT'); // a name in text is always fine
  assert.deepEqual(brands.sort(), ['GitHub', 'Kong', 'Python']);
  assert.deepEqual(brandElementIds(elements).sort(), ['chip', 'gh', 'list', 'py']);
});

test('prepareSceneAssets refuses what it cannot show', () => {
  const run = (els) => () => prepareSceneAssets(els, real, { builtin: ICON_NAMES, where: 'w' });
  assert.throws(run({ c: { type: 'chat', logo: 'chatgpt', messages: [] } }), /w: element "c", logo: the brand "chatgpt".*not allowed/);
  assert.throws(run({ c: { type: 'chat', messages: [{ text: 'x', logo: 'claude' }] } }), /message 1, logo: the brand "claude"/);
  assert.throws(run({ l: { type: 'logo', id: 'docker' } }), /not allowed/);
  assert.throws(run({ l: { type: 'logo' } }), /a logo needs `id`/);
  assert.throws(run({ l: { type: 'logo', id: 'github', label: false } }), /always shows its name/);
  assert.throws(run({ n: { type: 'node', icon: 'unicorn' } }), /no icon "unicorn"/);
  assert.throws(run({ n: { type: 'node', icon: 'github' } }), /brand mark, not an icon/);
  assert.throws(run({ i: { type: 'icon', id: 'nope' } }), /no icon "nope"/);
});

test('checkBrandBeats refuses a strike or dim on a brand mark', () => {
  assert.throws(() => checkBrandBeats([{ at: 'here', strike: 'gh' }], ['gh'], 'seg'), /seg: beat at "here" would strike "gh", which shows a brand mark/);
  assert.throws(() => checkBrandBeats([{ dim: ['list/1'] }], ['list'], 'seg'), /would dim "list\/1"/);
  assert.doesNotThrow(() => checkBrandBeats([{ strike: 'other', ring: 'gh', show: 'gh' }], ['gh'], 'seg'));
});

test('trademarkLine names the brands shown', () => {
  assert.equal(trademarkLine(real, ['Python', 'GitHub', 'GitHub']), 'Trademarks (GitHub and Python) belong to their owners and are used here only to identify their products. No endorsement or affiliation is implied.');
  assert.match(trademarkLine(real, ['Kong', 'Python', 'GitHub']), /\(GitHub, Kong and Python\)/);
  assert.match(trademarkLine(real, []), /^Trademarks belong to their respective owners/);
});
