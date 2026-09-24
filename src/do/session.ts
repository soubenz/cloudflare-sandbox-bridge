import { DurableObject } from 'cloudflare:workers';
import type { Env, Family } from '../env';
import type { LabManifest } from '../labs/manifest';
import { SessionRuntime } from '../session/state';
import type { SessionMeta, ChecksRun, ServiceRuntime, SnapshotEntry } from '../session/state';
import * as lifecycle from '../session/lifecycle';
import { openEventStream, emitEvent, type EventType } from '../session/events';
import { openTerminalSocket, handleClientMessage, handleClientClose } from '../session/terminal';
import { proxyService } from '../session/proxy';
import { runChecks } from '../session/checks';
import { restartService as restartServiceImpl } from '../session/services';
import { recordLlmCost } from '../session/metrics';
import { ApiError, fromSdkError } from '../lib/errors';

/**
 * One Session Durable Object per lab session (`env.SESSION.idFromName(sessionId)`).
 * Deliberately thin: every RPC method here just delegates into session/*
 * modules against `this.rt`, a `SessionRuntime` built once in the
 * constructor from `ctx.id.name` (the sessionId — available because every
 * caller creates this DO's id via `idFromName`, never `newUniqueId`).
 * `fetch()` handles the three streaming paths (terminal WS, events SSE,
 * service proxy) that can't cross the RPC boundary as plain JSON.
 */
export class Session extends DurableObject<Env> {
  private readonly rt: SessionRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sessionId = ctx.id.name;
    if (!sessionId) throw new Error('Session DO must be addressed via idFromName(sessionId)');
    this.rt = new SessionRuntime(ctx, env, sessionId);
    ctx.blockConcurrencyWhile(async () => {
      const meta = await this.rt.meta();
      if (meta?.sandbox_id) await this.rt.bindBackend(meta.family, meta.sandbox_id);
    });
  }

  // --- RPC surface ---

  async create(input: { userId: string; labSlug: string; labVersion: string; family: Family; manifest: LabManifest }) {
    return lifecycle.createSession(this.rt, input);
  }

  async status(): Promise<{
    meta: SessionMeta;
    services: Record<string, ServiceRuntime>;
    snapshots: SnapshotEntry[];
    checks?: ChecksRun;
  }> {
    const meta = await this.rt.requireMeta();
    const [services, snapshots, checks] = await Promise.all([this.rt.services(), this.rt.snapshots(), this.rt.lastChecks()]);
    return { meta, services, snapshots, checks };
  }

  async runChecks(only?: string[]): Promise<ChecksRun> {
    const manifest = await this.rt.requireManifest();
    return runChecks(this.rt, manifest, only);
  }

  async restartService(name: string): Promise<ServiceRuntime> {
    return restartServiceImpl(this.rt, name);
  }

  async snapshot(): Promise<SnapshotEntry> {
    return lifecycle.snapshotNow(this.rt, 'user');
  }

  async resume(): Promise<{ meta: SessionMeta; token: string }> {
    return lifecycle.requestResume(this.rt);
  }

  async end(snapshot = true): Promise<void> {
    return lifecycle.endSession(this.rt, 'user', snapshot);
  }

  async readFile(path: string) {
    return this.rt.backend().readFile(path);
  }
  async writeFile(path: string, content: string): Promise<void> {
    await this.rt.backend().writeFile(path, content);
    await this.rt.touchInput();
  }
  async listFiles(path: string) {
    return this.rt.backend().listFiles(path);
  }
  async deleteFile(path: string): Promise<void> {
    await this.rt.backend().deleteFile(path);
    await this.rt.touchInput();
  }

  /**
   * Called by POST /sessions/{id}/events (service-key auth) — the LLM
   * Worker reporting spend or a completed call. `type` is the one place an
   * external caller picks the event name, so it's validated against the
   * known set rather than trusted blindly.
   */
  async pushEvent(type: string, data: unknown): Promise<void> {
    const known: EventType[] = ['cost', 'llm.call', 'alert'];
    if (!known.includes(type as EventType)) throw ApiError.badRequest('unknown_event_type', `Unknown event type "${type}"`);
    if (type === 'llm.call' && typeof (data as { cost_usd?: number })?.cost_usd === 'number') {
      await recordLlmCost(this.rt, (data as { cost_usd: number }).cost_usd);
    }
    emitEvent(this.rt, type as EventType, data);
  }

  // --- alarm ---

  async alarm(): Promise<void> {
    await lifecycle.handleAlarm(this.rt);
  }

  // --- fetch: terminal WS, events SSE, service proxy ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ["sessions", ":id", ...]
    const rest = parts.slice(2);

    try {
      if (rest[0] === 'terminal') {
        if (!isWebSocketRequest(request)) {
          // Named explicitly rather than falling through to a bare 404,
          // which is what this did and which said nothing useful: over
          // HTTP/2 there is no `Upgrade` header at all (h2 forbids it),
          // so gating on that alone rejected every browser handshake
          // while Node clients, which speak HTTP/1.1, worked.
          // Worth naming the likely cause: `Upgrade` and `Connection` are
          // hop-by-hop headers, so an intermediary that re-issues the
          // request rather than tunnelling it drops them, and the client
          // sees a failure it did nothing to cause.
          throw ApiError.badRequest(
            'not_a_websocket',
            `The terminal route needs a WebSocket handshake carrying "Upgrade: websocket". ` +
              `Got method ${request.method} with headers: ${[...request.headers.keys()].join(',')}. ` +
              `If the client did send it, a proxy in between has stripped it.`
          );
        }
        return openTerminalSocket(this.rt, request);
      }
      if (rest[0] === 'events') {
        return openEventStream(this.rt, request.headers.get('Last-Event-ID'));
      }
      if (rest[0] === 'services' && rest[1]) {
        return proxyService(this.rt, request, rest[1], this.rt.sessionId);
      }
      throw ApiError.notFound('not_found', `No such DO route: ${url.pathname}`);
    } catch (err) {
      if (err instanceof ApiError) return err.toResponse();
      return fromSdkError(err).toResponse();
    }
  }

  // --- WebSocket hibernation hooks (terminal client sockets) ---

  async webSocketMessage(_ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await handleClientMessage(this.rt, message);
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    handleClientClose(this.rt);
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    handleClientClose(this.rt);
  }
}

/**
 * `Upgrade: websocket` and nothing else, because that is the condition the
 * Workers runtime itself enforces: returning a WebSocket in response to a
 * request without that header fails with "Worker tried to return a
 * WebSocket in a response to a request which did not contain the header
 * Upgrade: websocket". Accepting a request on any weaker signal cannot
 * succeed — it only turns a clear rejection into that opaque 500.
 */
function isWebSocketRequest(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}
