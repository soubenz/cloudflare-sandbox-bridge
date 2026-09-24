import type { Context, Next } from 'hono';
import type { Env } from './env';

/**
 * The dashboard is deployed as its own Worker, so every call it makes —
 * including the SSE stream, which EventSource opens with no headers of its
 * own — is cross-origin. Allowed origins come from a var rather than `*`
 * so the list is visible in config and can be changed without a code
 * change.
 */
export function corsMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const origin = c.req.header('Origin');
    const allowed = allowedOrigin(c.env, origin);

    if (c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Method')) {
      return new Response(null, {
        status: 204,
        headers: preflightHeaders(allowed, c.req.header('Access-Control-Request-Headers')),
      });
    }

    // A WebSocket upgrade is not subject to CORS, and its 101 response
    // carries a `webSocket` that cannot survive being copied into a new
    // Response — so this must not touch the response at all. Browsers do
    // send Origin on a handshake, which is what made this path reachable:
    // the terminal worked from Node and returned 500 from a browser.
    if (c.req.header('Upgrade')?.toLowerCase() === 'websocket') {
      await next();
      return;
    }

    await next();
    if (!allowed) return;

    // Responses that came back from a Durable Object are subrequest
    // responses, and their headers are immutable — setting one throws
    // "Can't modify immutable headers", which surfaced as a 500 on the
    // terminal and as a missing CORS header on the SSE stream. Rebuild
    // the response instead; passing `body` through keeps a stream
    // streaming rather than buffering it.
    const headers = new Headers(c.res.headers);
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Access-Control-Expose-Headers', 'Content-Type');
    headers.append('Vary', 'Origin');

    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  };
}

function allowedOrigin(env: Env, origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const list = (env.DASHBOARD_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return list.includes(origin) ? origin : undefined;
}

function preflightHeaders(allowed: string | undefined, requested: string | undefined): HeadersInit {
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': requested ?? 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
