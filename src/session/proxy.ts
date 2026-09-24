import type { SessionRuntime } from './state';
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
  const services = await rt.services();
  const service = services[serviceName];
  if (!service) throw ApiError.notFound('unknown_service', `No service "${serviceName}" in this lab`);
  if (!service.spec.port) throw ApiError.badRequest('no_ui', `Service "${serviceName}" has no proxyable port`);
  if (service.health === 'unhealthy') {
    throw new ApiError(502, 'service_down', `Service "${serviceName}" is currently unhealthy`, { health: service.health });
  }

  await rt.touchInput();
  const backend = rt.backend();
  const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  if (isUpgrade) {
    return backend.wsConnect(request, service.spec.port);
  }

  const url = new URL(request.url);
  const hadToken = url.searchParams.has('token');
  url.searchParams.delete('token');

  const forwarded = new Request(url, request);
  forwarded.headers.set('X-Forwarded-Prefix', `/sessions/${sessionId}/services/${serviceName}`);
  forwarded.headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

  const upstream = await backend.containerFetch(forwarded, service.spec.port);

  if (hadToken) {
    // First hit with ?token=...: set a session cookie scoped to this
    // session's service paths, so the service's own links and assets do
    // not need the query param (which some UIs strip or mangle when
    // building their own URLs).
    //
    // Partitioned (CHIPS) because the console embeds this in an iframe
    // from a different origin, which makes it a third-party cookie —
    // blocked by default in current browsers without it. Partitioned
    // gives the embed its own jar keyed to the embedding site, which is
    // exactly the intent: the cookie is only ever meant for this session
    // inside this page.
    const token = new URL(request.url).searchParams.get('token')!;
    const headers = new Headers(upstream.headers);
    headers.append(
      'Set-Cookie',
      `opx_s_${sessionId}=${token}; Path=/sessions/${sessionId}/; HttpOnly; Secure; SameSite=None; Partitioned`
    );
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  return upstream;
}
