/**
 * A small stand-in for the browser's DOM, for unit tests that mount a console component and play it with
 * keys and clicks (this repo has no jsdom: the vitest pool is plain Node). It has what the console's
 * components use: elements with attributes, classes, `dataset`, `style`, text, events that bubble, focus,
 * click, and querySelector / closest / matches over simple selectors (tag, #id, .class, [attr], [attr="v"],
 * :disabled, compounds of those, the descendant combinator and comma lists). `innerHTML` is kept as a string
 * and draws no children (the components assign only their own SVG to it).
 *
 *   const dom = installFakeDom();   // sets globalThis.document; dom.restore() puts back what was there
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener = (e: FakeEvent) => void;

export class FakeEvent {
  type: string;
  bubbles: boolean;
  target: any = null;
  currentTarget: any = null;
  defaultPrevented = false;
  stopped = false;
  [k: string]: any;
  constructor(type: string, init: Record<string, any> = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

class FakeText {
  nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
  set textContent(v: string) {
    this.data = String(v);
  }
  cloneNode() {
    return new FakeText(this.data);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
}

const camelToKebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export class FakeElement {
  nodeType = 1;
  tagName: string;
  namespaceURI: string | null;
  parentNode: FakeElement | null = null;
  childNodes: Array<FakeElement | FakeText> = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  style: Record<string, any>;
  dataset: Record<string, string>;
  rawHTML = '';
  value = '';
  type = '';
  min = '';
  max = '';
  step = '';
  [k: string]: any;
  owner: FakeDocument;

  constructor(tag: string, owner: FakeDocument, ns: string | null = null) {
    this.tagName = tag.toUpperCase();
    this.namespaceURI = ns;
    this.owner = owner;
    const props: Record<string, string> = {};
    this.style = {
      ...props,
      setProperty(k: string, v: string) {
        this[k] = v;
      },
      removeProperty(k: string) {
        delete this[k];
      },
      getPropertyValue(k: string) {
        return this[k] ?? '';
      },
    };
    const el = this;
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, k) => (typeof k === 'string' ? el.attrs.get(`data-${camelToKebab(k)}`) : undefined),
      set: (_t, k, v) => {
        el.attrs.set(`data-${camelToKebab(String(k))}`, String(v));
        return true;
      },
      deleteProperty: (_t, k) => {
        el.attrs.delete(`data-${camelToKebab(String(k))}`);
        return true;
      },
      has: (_t, k) => el.attrs.has(`data-${camelToKebab(String(k))}`),
      ownKeys: () => [...el.attrs.keys()].filter((a) => a.startsWith('data-')).map((a) => a.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  }

  // --- attributes ----------------------------------------------------------
  setAttribute(k: string, v: unknown) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  get id() {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', String(v));
  }
  get className() {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', String(v));
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c: string[]) => (el.className = [...new Set([...list(), ...c])].join(' ')),
      remove: (...c: string[]) => (el.className = list().filter((x) => !c.includes(x)).join(' ')),
      contains: (c: string) => list().includes(c),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !list().includes(c);
        if (on) el.className = [...new Set([...list(), c])].join(' ');
        else el.className = list().filter((x) => x !== c).join(' ');
        return on;
      },
    };
  }
  get hidden() {
    return this.attrs.has('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }
  get disabled() {
    return this.attrs.has('disabled');
  }
  set disabled(v: boolean) {
    if (v) this.attrs.set('disabled', '');
    else this.attrs.delete('disabled');
  }
  get tabIndex() {
    return Number(this.attrs.get('tabindex') ?? (this.tagName === 'BUTTON' ? 0 : -1));
  }
  set tabIndex(v: number) {
    this.attrs.set('tabindex', String(v));
  }
  get htmlFor() {
    return this.attrs.get('for') ?? '';
  }
  set htmlFor(v: string) {
    this.attrs.set('for', v);
  }

  // --- tree ----------------------------------------------------------------
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeElement | FakeText | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get isConnected(): boolean {
    let n: FakeElement | null = this;
    while (n) {
      if (n === this.owner.body) return true;
      n = n.parentNode;
    }
    return false;
  }
  private adopt(n: FakeElement | FakeText | string) {
    const node = typeof n === 'string' ? new FakeText(n) : n;
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    return node;
  }
  append(...nodes: Array<FakeElement | FakeText | string>) {
    for (const n of nodes) this.childNodes.push(this.adopt(n));
  }
  appendChild(n: FakeElement | FakeText) {
    this.append(n);
    return n;
  }
  prepend(...nodes: Array<FakeElement | FakeText | string>) {
    const adopted = nodes.map((n) => this.adopt(n));
    this.childNodes.unshift(...adopted);
  }
  insertBefore(n: FakeElement | FakeText, ref: FakeElement | FakeText | null) {
    const node = this.adopt(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return n;
  }
  before(...nodes: Array<FakeElement | FakeText | string>) {
    const p = this.parentNode;
    if (!p) return;
    for (const n of nodes) p.insertBefore(typeof n === 'string' ? new FakeText(n) : n, this);
  }
  removeChild(n: FakeElement | FakeText) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...nodes: Array<FakeElement | FakeText | string>) {
    for (const c of [...this.childNodes]) c.parentNode = null;
    this.childNodes = [];
    this.rawHTML = '';
    this.append(...nodes);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  contains(n: any): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  cloneNode() {
    const c = new FakeElement(this.tagName, this.owner, this.namespaceURI);
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    for (const ch of this.childNodes) c.append(ch.cloneNode() as any);
    return c;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.replaceChildren(String(v ?? ''));
  }
  get innerHTML() {
    return this.rawHTML;
  }
  set innerHTML(v: string) {
    this.replaceChildren();
    this.rawHTML = String(v);
  }
  get offsetWidth() {
    return 0;
  }
  get offsetHeight() {
    return 0;
  }
  get offsetTop() {
    return 0;
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}

  // --- events --------------------------------------------------------------
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((x) => x !== fn));
  }
  dispatchEvent(e: FakeEvent) {
    e.target ??= this;
    for (let n: FakeElement | null = this; n; n = n.parentNode) {
      e.currentTarget = n;
      for (const fn of [...(n.listeners.get(e.type) ?? [])]) fn.call(n, e);
      if (e.stopped || !e.bubbles) break;
    }
    return !e.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent('click'));
  }
  focus() {
    this.owner.activeElement = this;
  }
  blur() {
    if (this.owner.activeElement === this) this.owner.activeElement = this.owner.body;
  }

  // --- selectors -----------------------------------------------------------
  matches(sel: string): boolean {
    return parseList(sel).some((chain) => matchChain(this, chain));
  }
  closest(sel: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeElement) => {
      for (const c of n.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

// A compound: { tag, id, classes, attrs: [name, value?], disabled }
type Compound = { tag?: string; id?: string; classes: string[]; attrs: Array<[string, string | undefined]>; disabled?: boolean };

function parseCompound(s: string): Compound {
  const c: Compound = { classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|(:disabled)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push([m[4], m[5] ?? m[6] ?? m[7]]);
    else if (m[8]) c.disabled = true;
  }
  return c;
}

function parseList(sel: string): Compound[][] {
  return sel.split(',').map((part) => part.trim().split(/\s+/).filter(Boolean).map(parseCompound));
}

function matchCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  const cls = el.className.split(/\s+/);
  if (c.classes.some((x) => !cls.includes(x))) return false;
  for (const [k, v] of c.attrs) {
    if (!el.attrs.has(k)) return false;
    if (v !== undefined && el.attrs.get(k) !== v) return false;
  }
  if (c.disabled && !el.disabled) return false;
  return true;
}

function matchChain(el: FakeElement, chain: Compound[]): boolean {
  if (!chain.length || !matchCompound(el, chain[chain.length - 1]!)) return false;
  let i = chain.length - 2;
  for (let n = el.parentNode; n && i >= 0; n = n.parentNode) if (matchCompound(n, chain[i]!)) i--;
  return i < 0;
}

export class FakeDocument {
  body: FakeElement;
  documentElement: FakeElement;
  activeElement: FakeElement;
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.append(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  createElementNS(ns: string, tag: string) {
    return new FakeElement(tag, this, ns);
  }
  createTextNode(text: string) {
    return new FakeText(text);
  }
  querySelector(sel: string) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel: string) {
    return this.documentElement.querySelectorAll(sel);
  }
}

/** Puts a fresh FakeDocument on globalThis.document. `restore()` puts back what was there. */
export function installFakeDom() {
  const g = globalThis as any;
  const before = g.document;
  const doc = new FakeDocument();
  g.document = doc;
  return {
    document: doc,
    restore() {
      g.document = before;
    },
  };
}

/** Presses a key on whatever has focus (or on `el`): a bubbling keydown. Returns the event. */
export function press(doc: FakeDocument, key: string, el?: FakeElement) {
  const e = new FakeEvent('keydown', { key });
  (el ?? doc.activeElement).dispatchEvent(e);
  return e;
}

/** A clock the test moves by hand: `tick(ms)` runs every timer due by then, in order. */
export function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      due.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (id: number) => {
      due.delete(id);
    },
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of due) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => due.size,
  };
}
