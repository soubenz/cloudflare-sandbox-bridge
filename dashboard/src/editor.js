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
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, Prec } from '@codemirror/state';
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

export async function createEditor(mount, { onChange, onSave } = {}) {
  const languageSlot = new Compartment();
  // Replacing the document to open a file is not an edit, and reporting it
  // as one made every freshly opened file look unsaved.
  let loading = false;

  const editor = new EditorView({
    doc: '',
    parent: mount,
    extensions: [
      // Mod-s is the reflex for "save" in every editor a learner has used;
      // without this the browser opened its own "Save page as" dialog.
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSave?.();
              return true;
            },
          },
        ])
      ),
      basicSetup,
      oneDark,
      languageSlot.of([]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !loading) onChange?.();
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px', backgroundColor: '#0b0e13' },
        '.cm-gutters': { backgroundColor: '#0b0e13', borderRight: '1px solid #262e3a' },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55' },
      }),
    ],
  });

  return {
    async load(text, filename) {
      const language = await loadLanguage(filename);
      loading = true;
      try {
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: text },
          effects: languageSlot.reconfigure(language ? [language] : []),
          selection: { anchor: 0 },
          scrollIntoView: true,
        });
      } finally {
        loading = false;
      }
    },
    value: () => editor.state.doc.toString(),
    focus: () => editor.focus(),
  };
}
