import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the admin panel: the browser bundle into admin/public/dist, the
 * Worker into admin/dist-worker, and the shared design files into
 * admin/public/design. All three are generated and ignored by git.
 *
 * The design files are copied, not linked: the site commits its own copies
 * (and a script checks they match), but a panel that is only ever deployed
 * from a fresh build has no reason to carry a second one that could drift.
 */
const here = dirname(fileURLToPath(import.meta.url));
const design = join(here, '../packages/design');

await build({
  entryPoints: [join(here, 'src/app.js')],
  outdir: join(here, 'public/dist'),
  bundle: true,
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

// Start from nothing so a file removed from packages/design does not linger.
await rm(join(here, 'public/design'), { recursive: true, force: true });
await mkdir(join(here, 'public/design'), { recursive: true });
await cp(join(design, 'tokens.css'), join(here, 'public/design/tokens.css'));
await cp(join(design, 'fonts.css'), join(here, 'public/design/fonts.css'));
await cp(join(design, 'fonts'), join(here, 'public/design/fonts'), { recursive: true });
console.log('design files copied to admin/public/design');
