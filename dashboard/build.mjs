import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
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
