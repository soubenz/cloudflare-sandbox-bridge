import { build } from 'esbuild';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the console into dashboard/public/dist.
 *
 * It used to load CodeMirror and xterm from a CDN as separate module
 * graphs, which gave CodeMirror two copies of @codemirror/state and broke
 * its instanceof checks outright ("Unrecognized extension value"). One
 * graph removes that whole class of problem, and removes the runtime
 * dependency on a third party being reachable.
 *
 * Code splitting keeps the language grammars out of the initial load: a
 * session that never opens a Python file never fetches the Python parser.
 */
const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'src/app.js')],
  outdir: join(here, 'public/dist'),
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  sourcemap: true,
  target: ['es2022'],
  logLevel: 'info',
});

// The diagram demo page (public/diagrams-demo.html, not linked from the app):
// a tiny entry that mounts every [data-diagram] placeholder from the shared
// library plus any JSON blocks in the page. Built from stdin, so it needs no
// source file of its own.
await build({
  stdin: {
    contents:
      "import { mountDiagrams } from './diagram.js';\n" +
      "import library from '../../packages/catalogue/diagrams.json';\n" +
      'mountDiagrams(document, library.diagrams);\n',
    resolveDir: join(here, 'src'),
    sourcefile: 'diagrams-demo-entry.js',
  },
  outfile: join(here, 'public/dist/diagrams-demo.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2022'],
  logLevel: 'info',
});

// The Worker's own bundle. Deliberately outside public/: anything in the
// assets directory is served as a static file, and the server side is not a
// static file.
await build({
  entryPoints: [join(here, 'src/worker.js')],
  outfile: join(here, 'dist-worker/worker.js'),
  bundle: true,
  format: 'esm',
  minify: false,
  target: ['es2022'],
  logLevel: 'info',
});

// xterm ships its own stylesheet; serve it rather than pulling it from a CDN.
await mkdir(join(here, 'public/dist'), { recursive: true });
await cp(
  join(here, '../node_modules/@xterm/xterm/css/xterm.css'),
  join(here, 'public/dist/xterm.css')
);

// The console's three typefaces (Funnel Display, Funnel Sans, JetBrains Mono),
// self-hosted from the shared design package so the page makes no third-party
// request and the CSP can stay `font-src 'self'`. styles.css declares the
// @font-face rules and points at dist/fonts/.
const fontsFrom = join(here, '../packages/design/fonts');
const fontsTo = join(here, 'public/dist/fonts');
await mkdir(fontsTo, { recursive: true });
for (const file of await readdir(fontsFrom)) {
  if (file.endsWith('.woff2') || file === 'OFL.txt') await cp(join(fontsFrom, file), join(fontsTo, file));
}
