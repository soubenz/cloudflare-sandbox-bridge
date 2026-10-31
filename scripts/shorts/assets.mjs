/**
 * The shorts' asset library: brand marks and generic icons in
 * scripts/shorts/page/assets/, listed in its manifest.json with where each one
 * came from, its licence, its owner's guideline and whether we may use it.
 * See docs/assets.md.
 *
 * render.mjs loads the manifest, checks it, and resolves every `logo:` and
 * library `icon:` a scene names, inlining the SVG into the element spec so the
 * page needs no fetch. An asset the manifest does not list, or lists with
 * `allowed: false`, fails the render with a message that says what to do.
 * Pure Node, no DOM: assets.test.mjs covers it with `node --test`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = join(HERE, 'page/assets');
export const KINDS = ['brand', 'icon'];
const ID = /^[a-z0-9][a-z0-9-]*$/;
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

/**
 * Every problem with a manifest, as strings (empty when it is fine). With
 * `dir`, the files are checked too: they exist, are SVG, icons draw in
 * currentColor (so the theme can recolour them) and brand marks do not (their
 * colours are fixed by the owner's guideline).
 */
export function manifestProblems(m, { dir = null } = {}) {
  const out = [];
  if (!m || typeof m !== 'object' || !Array.isArray(m.assets)) return ['manifest needs { "assets": [ ... ] }'];
  if (!nonEmpty(m.trademarkLine) || !m.trademarkLine.includes('{names}')) out.push('manifest needs a "trademarkLine" with {names} in it');
  const seen = new Set();
  m.assets.forEach((a, i) => {
    const at = `asset ${i + 1}${a && nonEmpty(a.id) ? ` ("${a.id}")` : ''}`;
    if (!a || typeof a !== 'object') { out.push(`${at}: not an object`); return; }
    if (!nonEmpty(a.id) || !ID.test(a.id)) out.push(`${at}: id must be lower-case letters, digits and dashes`);
    else if (seen.has(a.id)) out.push(`${at}: id "${a.id}" is listed twice`);
    seen.add(a.id);
    if (!KINDS.includes(a.kind)) out.push(`${at}: kind must be brand or icon, not ${JSON.stringify(a.kind)}`);
    if (typeof a.allowed !== 'boolean') out.push(`${at}: allowed must be true or false`);
    for (const f of ['name', 'owner', 'licence']) if (!nonEmpty(a[f])) out.push(`${at}: needs "${f}"`);
    if (!Array.isArray(a.rules) || !a.rules.length || !a.rules.every(nonEmpty)) out.push(`${at}: needs "rules", a list of the owner's rules`);
    if (a.kind === 'brand' && !(a.guidelines === null || /^https:\/\//.test(a.guidelines ?? ''))) out.push(`${at}: "guidelines" must be the https URL of the owner's guideline (or null when none is published)`);
    if (a.allowed === true) {
      if (!nonEmpty(a.file) || !a.file.endsWith('.svg') || !a.file.startsWith(a.kind === 'brand' ? 'brands/' : 'icons/')) out.push(`${at}: an allowed ${a.kind} needs "file": "${a.kind === 'brand' ? 'brands' : 'icons'}/<name>.svg"`);
      if (!nonEmpty(a.source)) out.push(`${at}: an allowed asset needs "source" (package@version or the owner's download URL)`);
      if (!nonEmpty(a.color)) out.push(`${at}: an allowed asset needs "color" (how it is coloured on the navy board)`);
      if (a.kind === 'brand' && !nonEmpty(a.guidelines)) out.push(`${at}: an allowed brand needs the "guidelines" URL that permits the use`);
      if (dir && nonEmpty(a.file)) {
        const file = resolve(dir, a.file);
        if (!file.startsWith(resolve(dir) + sep)) out.push(`${at}: file ${a.file} is outside the assets folder`);
        else if (!existsSync(file)) out.push(`${at}: file ${a.file} is missing`);
        else {
          const svg = readFileSync(file, 'utf8');
          if (!/^<svg[\s>]/.test(svg.trim()) || !/viewBox="[^"]+"/.test(svg)) out.push(`${at}: ${a.file} must be a single <svg> with a viewBox`);
          if (/<script|\son[a-z]+=|href="(?!#)/i.test(svg)) out.push(`${at}: ${a.file} has scripts, event handlers or external links`);
          if (a.kind === 'icon' && !svg.includes('currentColor')) out.push(`${at}: icon ${a.file} must draw in currentColor so the theme can recolour it`);
          if (a.kind === 'brand' && svg.includes('currentColor')) out.push(`${at}: brand mark ${a.file} must carry its permitted colours, not currentColor`);
        }
      }
    } else if (a.allowed === false) {
      if (a.file != null) out.push(`${at}: a disallowed asset keeps no file (set "file": null and delete the SVG)`);
      if (!/^Do not use/.test(a.rules?.[0] ?? '')) out.push(`${at}: a disallowed asset's first rule must say "Do not use; write the name in text instead."`);
    }
  });
  return out;
}

/** The manifest of `dir`, checked (files included); throws listing every problem. */
export function loadManifest(dir = ASSETS_DIR) {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`assets: no ${path}`);
  let m;
  try { m = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`assets: ${path} is not JSON (${e.message})`); }
  const problems = manifestProblems(m, { dir });
  if (problems.length) throw new Error(`assets: ${path} has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  return { ...m, dir, byId: new Map(m.assets.map((a) => [a.id, a])) };
}

/** The aspect (width / height) of an SVG from its viewBox. */
export function aspectOf(svg) {
  const m = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 1;
}

/**
 * One asset for a scene: { id, name, kind, svg, aspect }. Throws, naming
 * `where`, when the manifest does not list it, does not allow it, or it is the
 * wrong kind (a brand where an icon was asked for, or the reverse).
 */
export function resolveAsset(manifest, id, { kind, where = 'scene' } = {}) {
  const a = manifest.byId.get(String(id));
  const known = (k) => manifest.assets.filter((x) => x.kind === k && x.allowed).map((x) => x.id).join(', ');
  if (!a) throw new Error(`${where}: no ${kind || 'asset'} "${id}" in scripts/shorts/page/assets/manifest.json. Usable ${kind || 'brand'}s: ${known(kind || 'brand')}. Add it there first (docs/assets.md), or write the name in text.`);
  if (kind && a.kind !== kind) {
    throw new Error(kind === 'icon'
      ? `${where}: "${id}" is a brand mark, not an icon: use \`logo: ${id}\` (or type: logo), which keeps its colours and shows its name`
      : `${where}: "${id}" is a generic icon, not a brand mark: use \`icon: ${id}\``);
  }
  if (!a.allowed) {
    throw new Error(`${where}: the ${a.kind} "${id}" (${a.name}, ${a.owner}) is not allowed by its owner's guidelines: ${a.rules.join(' ')}${a.guidelines ? ` (${a.guidelines})` : ''}. See docs/assets.md.`);
  }
  const svg = readFileSync(join(manifest.dir, a.file), 'utf8').trim();
  return { id: a.id, name: a.name, kind: a.kind, svg, aspect: aspectOf(svg) };
}

/**
 * Resolves the asset references of one scene's elements and returns
 * { elements, brands }: new element specs carrying the inlined marks, and the
 * names of the brands the scene shows (for the trademarks line).
 *
 * - `type: logo` with `id`: a brand mark; its `label` defaults to the brand's name.
 * - `logo: <id>` on a chip, node, list item, chat (its title bar) or chat message.
 * - `type: icon` with `id`, or `icon: <name>` anywhere: a built-in icon
 *   (`builtin`) or a library icon (`lib:<id>` always means the library one).
 */
export function prepareSceneAssets(elements, manifest, { builtin = [], where = 'scene' } = {}) {
  const brands = new Set();
  const builtins = new Set(builtin);
  const mark = (id, at) => {
    const a = resolveAsset(manifest, id, { kind: 'brand', where: at });
    brands.add(a.name);
    return a;
  };
  const iconOf = (name, at) => {
    const s = String(name);
    if (!s.startsWith('lib:') && builtins.has(s)) return null;
    const id = s.replace(/^lib:/, '');
    const a = manifest.byId.get(id);
    if (!a && !s.startsWith('lib:')) throw new Error(`${at}: no icon "${s}". Built-in icons: ${[...builtins].join(', ')}; library icons: ${manifest.assets.filter((x) => x.kind === 'icon' && x.allowed).map((x) => x.id).join(', ')}`);
    return resolveAsset(manifest, id, { kind: 'icon', where: at });
  };
  const withAssets = (spec, at) => {
    const out = { ...spec };
    if (spec.logo != null) out._mark = mark(spec.logo, `${at}, logo`);
    if (spec.icon != null && spec.type !== 'icon') {
      const ic = iconOf(spec.icon, `${at}, icon`);
      if (ic) out._icon = ic;
    }
    return out;
  };
  const out = {};
  for (const [id, el] of Object.entries(elements || {})) {
    const at = `${where}: element "${id}"`;
    let spec = { ...el };
    if (el.type === 'logo') {
      if (el.id == null) throw new Error(`${at}: a logo needs \`id\` (a brand of scripts/shorts/page/assets/manifest.json)`);
      if (el.label === false || el.label === '') throw new Error(`${at}: a brand mark always shows its name (label); leave label out to use "${manifest.byId.get(String(el.id))?.name ?? el.id}"`);
      spec._mark = mark(el.id, at);
      if (el.label == null) spec.label = spec._mark.name;
    } else if (el.type === 'icon') {
      if (el.id != null) spec._icon = resolveAsset(manifest, el.id, { kind: 'icon', where: at });
      else if (el.icon != null) { const ic = iconOf(el.icon, at); if (ic) spec._icon = ic; }
    } else {
      spec = withAssets(spec, at);
      if (el.type === 'list' && Array.isArray(el.items)) spec.items = el.items.map((x, k) => (x && typeof x === 'object' ? withAssets(x, `${at}, item ${k}`) : x));
      if (el.type === 'chat' && Array.isArray(el.messages)) spec.messages = el.messages.map((m, k) => (m && typeof m === 'object' ? withAssets(m, `${at}, message ${k + 1}`) : m));
    }
    out[id] = spec;
  }
  return { elements: out, brands: [...brands] };
}

/** Elements that show a brand mark: they may not be struck through or dimmed (that would alter the mark). */
export function brandElementIds(elements) {
  return Object.entries(elements || {}).filter(([, el]) => el._mark || (el.items || []).some((x) => x && x._mark) || (el.messages || []).some((m) => m && m._mark)).map(([id]) => id);
}

/** Throws when a beat would alter a brand mark: `strike` or `dim` on an element that shows one. */
export function checkBrandBeats(beats, brandIds, where = 'segment') {
  const ids = new Set(brandIds);
  const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  for (const b of beats || []) {
    for (const key of ['strike', 'dim']) {
      for (const id of asList(b[key])) {
        const base = String(id).split('/')[0];
        if (ids.has(base)) throw new Error(`${where}: beat at "${b.at ?? 'start'}" would ${key} "${id}", which shows a brand mark; trademarks may not be altered. Put the mark on its own element and ${key} something else.`);
      }
    }
  }
}

/** "A", "A and B", "A, B and C". */
const andList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The end card's (and the video description's) trademarks line for these brand names. */
export function trademarkLine(manifest, names) {
  const list = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  if (!list.length) return 'Trademarks belong to their respective owners. No endorsement or affiliation is implied.';
  return manifest.trademarkLine.replace('{names}', andList(list));
}
