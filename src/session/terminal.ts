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

/**
 * A stand-in upgrade request for reconnects, where the browser's original
 * request is long gone (this runs from the webSocketMessage hook). Both
 * headers are required: the Sandbox DO takes its WebSocket branch only
 * when `Connection: Upgrade` is present too, and otherwise rejects the
 * request outright. The URL is irrelevant — the SDK rewrites it.
 */
function syntheticUpgradeRequest(): Request {
  return new Request('http://do/internal/terminal', {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
  });
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
  // Binary frames arrive as Blob by default, and WebSocket.send() coerces a
  // Blob to the string "[object Blob]" — so every byte of terminal output
  // reached the client as that literal text.
  upstream.binaryType = 'arraybuffer';

  // The container's PTY speaks its own framing: JSON text frames for
  // control (`ready`, `chunk`, `truncated`, `error`, `exit`), each `chunk`
  // immediately followed by one binary frame carrying that many bytes of
  // output. Our clients get raw bytes instead, so the control frames are
  // consumed here rather than forwarded — passing them through would put
  // literal JSON in the learner's terminal. The cursors they carry are
  // what makes re-attach after a drop or a container restart resume where
  // the output left off, so they are recorded as they go by.
  // A `chunk` frame is immediately followed by its binary frame, so the
  // cursor must be recorded synchronously here — parking it behind a
  // promise would let the binary frame arrive first and pair each chunk's
  // bytes with the previous chunk's cursor.
  let pendingCursor: string | undefined;
  upstream.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const control = parseControlFrame(event.data);
      if (control?.type === 'chunk') pendingCursor = control.cursor;
      else if (control?.cursor) void persistCursor(rt, control.cursor);
      return;
    }
    broadcastToClients(rt, event.data);
    if (pendingCursor) {
      const cursor = pendingCursor;
      pendingCursor = undefined;
      void persistCursor(rt, cursor);
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

function broadcastToClients(rt: SessionRuntime, data: ArrayBuffer): void {
  for (const client of rt.ctx.getWebSockets('terminal')) {
    try {
      client.send(data);
    } catch {
      // Client socket closing/closed; webSocketClose will clean it up.
    }
  }
}

function parseControlFrame(frame: string): { type?: string; cursor?: string } | undefined {
  try {
    return JSON.parse(frame) as { type?: string; cursor?: string };
  } catch {
    return undefined;
  }
}

async function persistCursor(rt: SessionRuntime, cursor: string): Promise<void> {
  const term = await rt.terminal();
  if (term && term.cursor !== cursor) await rt.putTerminal({ ...term, cursor });
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

  // The upstream can drop under a still-attached client (the Sandbox DO is
  // evicted, or the PTY connection times out). Without this the socket is
  // simply gone and every keystroke is discarded in silence — the learner
  // sees a terminal that has stopped responding for no stated reason.
  if (rt.upstreamTerminalSocket?.readyState !== WebSocket.READY_STATE_OPEN) {
    try {
      await ensureUpstreamConnected(rt, syntheticUpgradeRequest());
    } catch (err) {
      emitEvent(rt, 'alert', { kind: 'terminal_reconnect_failed', error: String(err) });
      return;
    }
  }
  if (rt.upstreamTerminalSocket?.readyState === WebSocket.READY_STATE_OPEN) {
    rt.upstreamTerminalSocket.send(message);
  }
}

async function handleControlMessage(rt: SessionRuntime, body: string): Promise<void> {
  const msg = parseControlFrame(body) as { type?: string; cols?: number; rows?: number } | undefined;
  if (!msg || msg.type !== 'resize' || !msg.cols || !msg.rows) return;
  try {
    // Re-fetch the handle rather than reusing rt.upstreamTerminalHandle:
    // it wraps an RPC stub bound to the I/O context of the upgrade
    // request, and this runs later, from the webSocketMessage hook.
    const term = await rt.terminal();
    if (!term) return;
    const handle = await rt.backend().getTerminal(term.id);
    await handle?.resize(msg.cols, msg.rows);
    await rt.putTerminal({ ...term, cols: msg.cols, rows: msg.rows });
  } catch (err) {
    // Left unreported, a failed resize leaves the stored cols/rows stale
    // and a later re-attach rebuilds the PTY at the wrong size.
    emitEvent(rt, 'alert', { kind: 'terminal_resize_failed', error: String(err) });
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
