import { OpalixClient } from '../../cli/src/client';

export interface SseEvent {
  id: string;
  event: string;
  data: string;
}

/** Starts a session and waits for it to reach `running`. */
export async function startRunningSession(
  service: OpalixClient,
  baseUrl: string,
  lab: string,
  timeoutMs = 120_000
): Promise<{ id: string; token: string; session: OpalixClient }> {
  const started = await service.startSession(lab, `it-${lab}-${Date.now()}`);
  const session = new OpalixClient({ baseUrl, sessionToken: started.token });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (await session.status(started.id)).meta.state;
    if (state === 'running') return { id: started.id, token: started.token, session };
    if (state === 'ended') throw new Error(`session ${started.id} ended before running`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`session ${started.id} never reached running`);
}

/**
 * Reads an SSE stream until `done` matches an event or the deadline
 * passes, and returns everything seen. Used instead of a fixed event
 * count because the interesting event (pressure, container.restarted)
 * arrives after an unknown number of routine health/metrics events.
 */
export async function collectSse(
  url: string,
  timeoutMs: number,
  done: (e: SseEvent) => boolean,
  headers: Record<string, string> = {}
): Promise<SseEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events: SseEvent[] = [];
  try {
    const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}: ${await res.text().catch(() => '')}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finished = false;
    while (!finished) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, split);
        buf = buf.slice(split + 2);
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        events.push(parsed);
        if (done(parsed)) finished = true;
      }
    }
    await reader.cancel().catch(() => {});
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) throw err;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return events;
}

/** Reads up to `want` events, giving up after `timeoutMs`. */
export function readSse(
  url: string,
  want: number,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<SseEvent[]> {
  let seen = 0;
  return collectSse(url, timeoutMs, () => ++seen >= want, headers);
}

export function parseSseBlock(block: string): SseEvent | undefined {
  const out: SseEvent = { id: '', event: 'message', data: '' };
  let sawField = false;
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line.trim() === '') continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).trimStart();
    if (field === 'id') out.id = value;
    else if (field === 'event') out.event = value;
    else if (field === 'data') out.data += value;
    else continue;
    sawField = true;
  }
  return sawField ? out : undefined;
}

/**
 * Runs a shell command inside the session's container by driving the
 * terminal websocket, and returns everything the PTY printed plus the
 * exit status. This is the only route that executes arbitrary commands —
 * there is deliberately no debug exec endpoint — so the egress tests use
 * it to probe the container's own network view.
 *
 * The end marker is written split (`__DO""NE__`) so that the shell's echo
 * of the typed command does not itself match the marker we scan for.
 */
export async function execViaTerminal(
  terminalUrl: string,
  command: string,
  timeoutMs = 60_000
): Promise<{ output: string; exitCode: number }> {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(terminalUrl);
  ws.binaryType = 'nodebuffer'; // otherwise frames arrive as Blob and stringify to [object Blob]
  let buf = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('terminal did not open')), timeoutMs);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    ws.on('message', (d: Buffer | string) => {
      buf += d.toString();
    });

    // Let the prompt settle before typing, or the first keystrokes are lost.
    await new Promise((r) => setTimeout(r, 1500));
    buf = '';
    // Binary: the PTY takes raw bytes; a text frame is read as a control message.
    ws.send(Buffer.from(`${command}; echo __DO""NE__$?\n`));

    const deadline = Date.now() + timeoutMs;
    const marker = /__DONE__(\d+)/;
    while (Date.now() < deadline && !marker.test(buf)) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const m = buf.match(marker);
    if (!m) throw new Error(`command did not finish within ${timeoutMs}ms: ${command}\n--- got ---\n${buf}`);
    return { output: buf.slice(0, buf.indexOf(m[0])), exitCode: Number(m[1]) };
  } finally {
    ws.close();
  }
}
