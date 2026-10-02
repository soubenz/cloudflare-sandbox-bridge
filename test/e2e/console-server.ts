import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The local stand-in for the console, shared by the specs that need no password, no API and no
 * container (16 to 20): it serves dashboard/public (the built bundle, `npm run build:dashboard`
 * first) with the CSP from public/_headers, so a policy violation is seen here too.
 *
 * Like the Worker (`assets.not_found_handling: "single-page-application"`) it answers an address that
 * is not a file with index.html, so a deep link such as /labs/x/lessons, and a reload of one, load
 * the app. A path that looks like a file (it has an extension, or it is under /dist, /api or /auth)
 * that does not exist is a real 404, so a broken asset URL is not hidden behind the app.
 *
 * `serveWorker` puts the real Worker (dashboard/src/worker.js, with a fake service binding) in front
 * of the same files, for the specs that are about the password gate.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, '../../dashboard/public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** The CSP the deployed console sends (public/_headers). */
const CSP = /Content-Security-Policy:\s*(.+)/.exec(readFileSync(join(PUBLIC, '_headers'), 'utf8'))?.[1]?.trim();

/** Where a request is the app's to answer (not a file, not the API). */
function isAppAddress(pathname: string): boolean {
  if (/^\/(api|auth|dist)(\/|$)/.test(pathname)) return false;
  return !/\.[A-Za-z0-9]{1,8}$/.test(pathname.replace(/\/+$/, '').split('/').pop() ?? '');
}

/** The asset an address stands for: the file, index.html for an app address, or null (a 404). */
function assetFor(rawPath: string): { file: string; type: string } | null {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(rawPath.split('?')[0]!);
  } catch {
    /* a malformed escape is just an address the app will not know */
  }
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC, rel);
  const found = file.startsWith(PUBLIC) && existsSync(file) && statSync(file).isFile();
  if (!found) {
    if (!isAppAddress(pathname)) return null;
    file = join(PUBLIC, 'index.html');
  }
  return { file, type: MIME[extname(file)] ?? 'application/octet-stream' };
}

function listen(server: Server): Promise<{ url: string; server: Server }> {
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })));
}

export function serveConsole(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const asset = assetFor(req.url ?? '/');
    if (!asset) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', ...(CSP ? { 'content-security-policy': CSP } : {}) });
    res.end(readFileSync(asset.file));
  });
  return listen(server);
}

// ---------------------------------------------------------------- the real Worker

export interface WorkerApi {
  /** The catalogue GET /labs answers. */
  labs: unknown[];
  /** The bundle GET /labs/:slug/learn answers (null: no learning content). */
  learn: (slug: string) => unknown | null;
  /** The rows GET /users/:uid/sessions?active=1 answers (none by default). */
  sessions?: unknown[];
}

/**
 * The console Worker as it is deployed, minus Cloudflare: `ASSETS` is dashboard/public with the
 * single-page-application fallback, and `API` answers the few routes the launcher reads. Passwords
 * and the cookie are the Worker's own, so a sign-in here is the real one. `password` is `pw`.
 */
export async function serveWorker(api: WorkerApi): Promise<{ url: string; server: Server }> {
  const { default: worker } = (await import('../../dashboard/src/worker.js' as string)) as { default: { fetch: (req: Request, env: unknown) => Promise<Response> } };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const env = {
    CONSOLE_PASSWORD: 'pw',
    CONSOLE_COOKIE_SECRET: 'cookie-secret',
    SANDBOX_API_KEY: 'svc-key',
    API_BASE: 'https://api.internal',
    API_PUBLIC_ORIGIN: 'https://opalix-sandbox.soubenz94.workers.dev',
    ASSETS: {
      fetch: async (request: Request) => {
        const asset = assetFor(new URL(request.url).pathname);
        if (!asset) return new Response('not found', { status: 404 });
        return new Response(readFileSync(asset.file), { status: 200, headers: { 'content-type': asset.type, 'cache-control': 'no-store' } });
      },
    },
    API: {
      fetch: async (url: string) => {
        const { pathname } = new URL(url);
        if (pathname === '/labs') return json(api.labs);
        if (pathname.startsWith('/users/') && pathname.endsWith('/progress')) return json({ labs: [] });
        if (/^\/users\/[^/]+\/sessions$/.test(pathname)) return json(api.sessions ?? []);
        const learn = /^\/labs\/([^/]+)\/learn$/.exec(pathname);
        if (learn) {
          const bundle = api.learn(decodeURIComponent(learn[1]!));
          return bundle ? json({ version: '1.0.0', learn: bundle }) : json({ error: { code: 'no_learn', message: 'none' } }, 404);
        }
        if (pathname === '/learn/onboarding') return json({ error: { code: 'no_onboarding', message: 'none' } }, 404);
        return json({ error: 'not stubbed' }, 404);
      },
    },
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const origin = `http://${req.headers.host}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const response = await worker.fetch(new Request(origin + (req.url ?? '/'), { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }), env);
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((v, k) => {
      if (k !== 'set-cookie') out[k] = v;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return listen(server);
}
