import type { SessionRuntime } from './state';
import { emitEvent } from './events';
import { ApiError } from '../lib/errors';

const CONTROL_PREFIX = 0x01;

/**
 * DO-mediated terminal relay (plan section 4.1). The browser/CLI attaches
 * to a hibernatable client WebSocket the DO accepts via
 * `ctx.acceptWebSocket`; the DO separately holds one upstream WebSocket to
 * the container's PTY (from `Terminal.connect()`) and a `Terminal` RPC
 * handle for out-of-band calls like `resize()`. All client sockets tagged
 * "terminal" (there can be more than one — attaching twice is a shared
 * view, like tmux) see the same upstream stream.
 *
 * Not a passthrough of the SDK's own WebSocket response: relaying here
 * means every client frame can update `last_input_at` (the idle clock),
 * auth is checked once at upgrade time, and re-attach after a container
 * restart is transparent to the client.
 */
export async function openTerminalSocket(rt: SessionRuntime, request: Request): Promise<Response> {
  const meta = await rt.requireMeta();
  if (meta.state !== 'running') throw ApiError.conflict('not_running', `Session is ${meta.state}, not running`);

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  rt.ctx.acceptWebSocket(server, ['terminal']);

  await ensureUpstreamConnected(rt, request);
  await rt.touchInput();

  return new Response(null, { status: 101, webSocket: client });
}

async function ensureUpstreamConnected(rt: SessionRuntime, originRequest: Request): Promise<void> {
  if (rt.upstreamTerminalSocket && rt.upstreamTerminalSocket.readyState === WebSocket.READY_STATE_OPEN) return;

  const backend = rt.backend();
  const existingRef = await rt.terminal();
  const handle = existingRef ? await backend.getTerminal(existingRef.id) : null;
  const terminal =
    handle ??
    (await backend.createTerminal({
      command: ['su', '-l', 'learner', '-s', '/bin/bash'],
      cwd: '/workspace',
      cols: existingRef?.cols ?? 120,
      rows: existingRef?.rows ?? 30,
    }));

  if (!existingRef || !handle) {
    await rt.putTerminal({
      id: terminal.id,
      argv: ['su', '-l', 'learner', '-s', '/bin/bash'],
      cwd: '/workspace',
      cols: existingRef?.cols ?? 120,
      rows: existingRef?.rows ?? 30,
    });
  }

  // Hand the SDK the browser's real upgrade request, exactly as the SDK's
  // own bridge does. A synthetic one carrying only `Upgrade: websocket`
  // fails: the Sandbox DO takes its WebSocket branch only when BOTH
  // `Upgrade` and `Connection: Upgrade` are present, and otherwise falls
  // through to containerFetch(), which rejects /ws/terminal on the control
  // port outright with "Terminal connection is not authorized". The URL
  // here is irrelevant — the SDK rewrites it to /ws/terminal itself — and
  // the real request additionally carries the Sec-WebSocket-* headers the
  // container's own handshake expects.
  const connectResp = await terminal.connect(originRequest, { cursor: existingRef?.cursor });
  const upstream = connectResp.webSocket;
  if (!upstream) throw new Error('terminal.connect() did not return a WebSocket');
  upstream.accept();

  upstream.addEventListener('message', (event) => {
    for (const client of rt.ctx.getWebSockets('terminal')) {
      try {
        client.send(event.data as string | ArrayBuffer);
      } catch {
        // Client socket closing/closed; webSocketClose will clean it up.
      }
    }
  });
  upstream.addEventListener('close', () => {
    rt.upstreamTerminalSocket = undefined;
    rt.upstreamTerminalHandle = undefined;
    emitEvent(rt, 'alert', { kind: 'terminal_upstream_closed' });
  });
  upstream.addEventListener('error', () => {
    rt.upstreamTerminalSocket = undefined;
    rt.upstreamTerminalHandle = undefined;
  });

  rt.upstreamTerminalSocket = upstream;
  rt.upstreamTerminalHandle = terminal;
}

/** Called from the Session DO's `webSocketMessage` hibernation hook. */
export async function handleClientMessage(rt: SessionRuntime, message: ArrayBuffer | string): Promise<void> {
  await rt.touchInput();

  if (typeof message === 'string' && message.charCodeAt(0) === CONTROL_PREFIX) {
    await handleControlMessage(rt, message.slice(1));
    return;
  }
  if (message instanceof ArrayBuffer) {
    const bytes = new Uint8Array(message);
    if (bytes.length > 0 && bytes[0] === CONTROL_PREFIX) {
      await handleControlMessage(rt, new TextDecoder().decode(bytes.slice(1)));
      return;
    }
  }

  if (rt.upstreamTerminalSocket?.readyState === WebSocket.READY_STATE_OPEN) {
    rt.upstreamTerminalSocket.send(message);
  }
}

async function handleControlMessage(rt: SessionRuntime, body: string): Promise<void> {
  try {
    const msg = JSON.parse(body) as { type?: string; cols?: number; rows?: number };
    if (msg.type === 'resize' && msg.cols && msg.rows) {
      // Re-fetch the handle rather than reusing rt.upstreamTerminalHandle:
      // it wraps an RPC stub bound to the I/O context of the upgrade
      // request, and this runs later, from the webSocketMessage hook.
      const term = await rt.terminal();
      if (!term) return;
      const handle = await rt.backend().getTerminal(term.id);
      await handle?.resize(msg.cols, msg.rows);
      await rt.putTerminal({ ...term, cols: msg.cols, rows: msg.rows });
    }
  } catch {
    // Ignore malformed control frames.
  }
}

/** Called from the Session DO's `webSocketClose` hook. Closes the upstream only once every client has gone. */
export function handleClientClose(rt: SessionRuntime): void {
  const remaining = rt.ctx.getWebSockets('terminal');
  if (remaining.length === 0 && rt.upstreamTerminalSocket) {
    rt.upstreamTerminalSocket.close();
    rt.upstreamTerminalSocket = undefined;
    rt.upstreamTerminalHandle = undefined;
  }
}

/** Called by lifecycle.recover after a container restart — the old terminal id is invalid in the new container. */
export async function resetTerminal(rt: SessionRuntime): Promise<void> {
  rt.upstreamTerminalSocket?.close();
  rt.upstreamTerminalSocket = undefined;
  rt.upstreamTerminalHandle = undefined;
  await rt.putTerminal(undefined);
  for (const client of rt.ctx.getWebSockets('terminal')) {
    try {
      client.send('\x01' + JSON.stringify({ type: 'reset' }));
    } catch {
      // best-effort
    }
  }
}
