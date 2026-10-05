import type { ServiceRuntime, SessionRuntime } from './state';
import { ApiError } from '../lib/errors';

/**
 * Proxies `ANY /sessions/{id}/services/{name}/*` to the service's port
 * inside the container. Services are launched with a session-specific path
 * prefix baked into their own config (Grafana's `serve_from_sub_path`,
 * LiteLLM's `SERVER_ROOT_PATH` — see lifecycle.ts / labs/manifest.ts
 * templating), so the incoming path is forwarded unchanged; we only handle
 * auth (token-in-URL -> cookie) and the WebSocket upgrade case.
 */
export async function proxyService(rt: SessionRuntime, request: Request, serviceName: string, sessionId: string): Promise<Response> {
  const { service, port } = await proxyableService(rt, serviceName);
  if (service.health === 'unhealthy') {
    throw new ApiError(502, 'service_down', `Service "${serviceName}" is currently unhealthy`, { health: service.health });
  }

  // A browser navigating to `?token=...` (the console's fallback iframe, a
  // pasted link) used to get the service's page on the tokenised URL, with
  // the token left in the address bar, the history and any Referer. Set the
  // cookie and redirect to the same URL minus the token instead, before
  // touching the container. Only for a document GET: XHR/asset requests
  // that carry `?token=` keep the in-place cookie below, and a WebSocket
  // upgrade is not a navigation.
  const requestUrl = new URL(request.url);
  if (
    requestUrl.searchParams.has('token') &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' &&
    (request.headers.get('Accept') ?? '').includes('text/html')
  ) {
    const token = requestUrl.searchParams.get('token')!;
    requestUrl.searchParams.delete('token');
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${requestUrl.pathname}${requestUrl.search}`,
        'Set-Cookie': sessionCookie(sessionId, token),
        'Cache-Control': 'no-store',
      },
    });
  }

  // A page's own background requests (a UI polling for fresh data) are not the learner being there: counting them
  // kept a lab alive forever behind an open Jaeger tab. A page load, any write, and clients that do not say what a
  // request is for (the CLI, tests) still count.
  const dest = request.headers.get('Sec-Fetch-Dest');
  const background = (request.method === 'GET' || request.method === 'HEAD') && !!dest && !['document', 'iframe', 'frame'].includes(dest);
  if (!background) await rt.touchInput();
  const backend = rt.backend();
  const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  if (isUpgrade) {
    return backend.wsConnect(request, port);
  }

  const url = new URL(request.url);
  const hadToken = url.searchParams.has('token');
  url.searchParams.delete('token');

  const forwarded = new Request(url, request);
  forwarded.headers.set('X-Forwarded-Prefix', `/sessions/${sessionId}/services/${serviceName}`);
  forwarded.headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

  const upstream = await unframed(await backend.containerFetch(forwarded, port));

  if (hadToken) {
    // First hit with ?token=... that was not a document navigation (see
    // above): set the cookie on the response itself.
    const token = new URL(request.url).searchParams.get('token')!;
    const headers = new Headers(upstream.headers);
    headers.append('Set-Cookie', sessionCookie(sessionId, token));
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  return upstream;
}

/**
 * The service if it can be proxied, else the error the proxy has always
 * given. Shared with the cookie route so the two cannot disagree about what
 * is reachable.
 */
async function proxyableService(rt: SessionRuntime, serviceName: string): Promise<{ service: ServiceRuntime; port: number }> {
  const services = await rt.services();
  const service = services[serviceName];
  if (!service) throw ApiError.notFound('unknown_service', `No service "${serviceName}" in this lab`);
  const port = service.spec.port;
  if (!port) throw ApiError.badRequest('no_port', `Service "${serviceName}" has no proxyable port`);
  // `ui` decides what is reachable, not just what is advertised. It only
  // filtered the URL map before, so any service with a port was proxyable
  // by whoever held the session token — a lab that runs an admin API or a
  // metrics endpoint on a port it never meant to expose exposed it anyway.
  // The manifest default is false, so a lab opts a service in explicitly.
  if (!service.spec.ui) {
    throw new ApiError(403, 'not_exposed', `Service "${serviceName}" is not exposed (set ui: true in the manifest to proxy it)`);
  }
  return { service, port };
}

/**
 * The session cookie for the service paths: scoped to this session's
 * routes, so the service's own links and assets do not need `?token=`
 * (which some UIs strip or mangle when building their own URLs).
 *
 * Partitioned (CHIPS) because the console embeds services in an iframe from
 * a different origin, which makes this a third-party cookie — blocked by
 * default in current browsers without it. Partitioned gives the embed its
 * own jar keyed to the embedding site, which is exactly the intent: the
 * cookie is only ever meant for this session inside this page.
 */
export function sessionCookie(sessionId: string, token: string): string {
  return `opx_s_${sessionId}=${token}; Path=/sessions/${sessionId}/; HttpOnly; Secure; SameSite=None; Partitioned`;
}

/**
 * `POST /sessions/{id}/services/{name}/session`: sets the same cookie the
 * `?token=` path sets, but from a credentialed `fetch`, so the console can
 * point an iframe (and an "open in new tab" link) at a URL with no token in
 * it. The token is the caller's own bearer (or `?token=`) — never a service
 * key, which the router refuses before this runs. Health is deliberately
 * not checked: the cookie is valid whether or not the service is up, and
 * the console learns it is down from the proxy itself.
 */
export async function mintServiceCookie(rt: SessionRuntime, request: Request, serviceName: string, sessionId: string): Promise<Response> {
  await proxyableService(rt, serviceName);
  const header = request.headers.get('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : new URL(request.url).searchParams.get('token');
  if (!token) throw ApiError.unauthorized('Send the session token as "Authorization: Bearer <token>"');
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': sessionCookie(sessionId, token), 'Cache-Control': 'no-store' },
  });
}

/**
 * Strips the headers that stop a service UI being embedded in the console.
 *
 * The console shows every `ui: true` service in an iframe, and plenty of
 * real software refuses to be framed by default — Grafana ships
 * `allow_embedding = false`, which sends `X-Frame-Options: deny`, so its
 * tab rendered as "refused to connect" with nothing to explain why.
 *
 * Stripping here rather than only configuring each image, because a lab
 * may run any service and we do not control most of them. The header is
 * defending against a page the learner did not choose to load; this proxy
 * already required a session token to reach the service at all, and the
 * only frame it can end up in is the console that minted that token.
 *
 * CSP is rewritten rather than dropped: `frame-ancestors` is the directive
 * that blocks embedding, and the rest of a service's policy is its own
 * business.
 */
async function unframed(upstream: Response): Promise<Response> {
  const csp = upstream.headers.get('content-security-policy');
  if (!upstream.headers.has('x-frame-options') && !csp?.includes('frame-ancestors')) return upstream;

  const headers = new Headers(upstream.headers);
  headers.delete('x-frame-options');
  if (csp) {
    const kept = csp
      .split(';')
      .filter((directive) => !directive.trim().toLowerCase().startsWith('frame-ancestors'))
      .join(';')
      .trim();
    if (kept) headers.set('content-security-policy', kept);
    else headers.delete('content-security-policy');
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}
