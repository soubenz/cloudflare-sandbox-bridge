/**
 * The workspace editor.
 *
 * A bare textarea was enough to prove the file routes worked, but the core
 * loop of a lab is reading a broken system and editing code — and a
 * textarea has no highlighting, no line numbers, and moves focus when you
 * press Tab, which makes editing Python actively unpleasant.
 *
 * CodeMirror is bundled rather than fetched from a CDN: loading it and its
 * language packages as separate CDN graphs gave it two copies of
 * @codemirror/state and broke its instanceof checks outright. The grammars
 * are still split out, so a session that never opens a Python file never
 * downloads the Python parser.
 */
import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';

/** Grammar per file extension, imported on demand so the initial load stays small. */
const GRAMMARS = {
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
};

async function loadLanguage(filename) {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  return GRAMMARS[ext] ? GRAMMARS[ext]() : null;
}

export async function createEditor(mount, { onChange } = {}) {
  const languageSlot = new Compartment();

  const editor = new EditorView({
    doc: '',
    parent: mount,
    extensions: [
      basicSetup,
      oneDark,
      languageSlot.of([]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange?.();
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px' },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      }),
    ],
  });

  return {
    async load(text, filename) {
      const language = await loadLanguage(filename);
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: text },
        effects: languageSlot.reconfigure(language ? [language] : []),
      });
    },
    value: () => editor.state.doc.toString(),
    focus: () => editor.focus(),
  };
}
