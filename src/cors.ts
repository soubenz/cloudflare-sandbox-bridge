import type { Context, Next } from 'hono';
import type { Env } from './env';

/**
 * The dashboard is deployed as its own Worker, so every call it makes —
 * including the SSE stream, which EventSource opens with no headers of its
 * own — is cross-origin. Allowed origins come from a var rather than `*`
 * so the list is visible in config and can be changed without a code
 * change.
 *
 * WebSocket upgrades are not subject to CORS and must not be touched: a
 * 101 response has no mutable headers.
 */
export function corsMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const origin = c.req.header('Origin');
    const allowed = allowedOrigin(c.env, origin);

    if (c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Method')) {
      return new Response(null, { status: 204, headers: preflightHeaders(allowed, c.req.header('Access-Control-Request-Headers')) });
    }

    await next();

    if (!allowed || c.res.status === 101) return;
    c.res.headers.set('Access-Control-Allow-Origin', allowed);
    c.res.headers.set('Vary', 'Origin');
    c.res.headers.set('Access-Control-Expose-Headers', 'Content-Type');
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
