import type { SessionRuntime } from './state';
import { encodeSseEvent, encodeSseComment } from '../lib/sse';

const MAX_EVENTS = 1000;

/** Event type names emitted onto the session's SSE stream (see plan section 4.2). */
export type EventType =
  | 'session.state'
  | 'session.expiring'
  | 'session.idle_warning'
  | 'service.health'
  | 'container.restarted'
  | 'pressure'
  | 'check.started'
  | 'check.result'
  | 'check.finished'
  | 'snapshot.created'
  | 'metrics'
  | 'cost'
  | 'llm.call'
  | 'alert';

function ensureEventsTable(rt: SessionRuntime): void {
  rt.sql.exec(
    `CREATE TABLE IF NOT EXISTS events (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       ts INTEGER NOT NULL,
       type TEXT NOT NULL,
       data TEXT NOT NULL
     )`
  );
}

/**
 * Records an event to the durable ring buffer and fans it out to every
 * currently-attached SSE writer. Called from every session/* module that
 * has something worth telling a watching browser or CLI about — never call
 * `sql.exec` on the events table directly outside this file.
 */
export function emitEvent(rt: SessionRuntime, type: EventType, data: unknown): void {
  ensureEventsTable(rt);
  const ts = Date.now();
  const json = JSON.stringify(data ?? {});
  rt.sql.exec('INSERT INTO events (ts, type, data) VALUES (?, ?, ?)', ts, type, json);
  // Trim to the last MAX_EVENTS rows. Cheap relative to the insert; run every time
  // rather than batching, since session event volume is low (tens per session).
  rt.sql.exec(
    `DELETE FROM events WHERE seq < (SELECT COALESCE(MAX(seq), 0) - ? + 1 FROM events)`,
    MAX_EVENTS
  );

  const seqRow = [...rt.sql.exec('SELECT last_insert_rowid() AS seq')][0] as { seq: number } | undefined;
  const seq = seqRow?.seq ?? 0;
  const frame = encodeSseEvent(type, data, seq);
  const bytes = new TextEncoder().encode(frame);
  for (const writer of rt.sseWriters) {
    writer.write(bytes).catch(() => rt.sseWriters.delete(writer));
  }
}

interface EventRow {
  seq: number;
  ts: number;
  type: string;
  data: string;
}

function replayRows(rt: SessionRuntime, afterSeq: number | null): EventRow[] {
  ensureEventsTable(rt);
  const rows =
    afterSeq === null
      ? [...rt.sql.exec('SELECT seq, ts, type, data FROM events ORDER BY seq DESC LIMIT 50')].reverse()
      : [...rt.sql.exec('SELECT seq, ts, type, data FROM events WHERE seq > ? ORDER BY seq ASC', afterSeq)];
  return rows as unknown as EventRow[];
}

/**
 * Handles `GET /sessions/{id}/events`. Replays from `Last-Event-ID` (or the
 * last 50 rows if absent/invalid), then streams live until the client
 * disconnects. Keeping the writer in `rt.sseWriters` is what makes the
 * fan-out in `emitEvent` reach this connection.
 */
export function openEventStream(rt: SessionRuntime, lastEventId: string | null): Response {
  const afterSeq = lastEventId !== null && /^\d+$/.test(lastEventId) ? Number.parseInt(lastEventId, 10) : null;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  rt.sseWriters.add(writer);

  const replay = replayRows(rt, afterSeq);
  const encoder = new TextEncoder();
  (async () => {
    for (const row of replay) {
      await writer.write(encoder.encode(encodeSseEvent(row.type, JSON.parse(row.data), row.seq)));
    }
  })().catch(() => rt.sseWriters.delete(writer));

  const pingInterval = setInterval(() => {
    writer.write(encoder.encode(encodeSseComment('ping'))).catch(() => {
      clearInterval(pingInterval);
      rt.sseWriters.delete(writer);
    });
  }, 20_000);

  writer.closed
    .catch(() => {})
    .finally(() => {
      clearInterval(pingInterval);
      rt.sseWriters.delete(writer);
    });

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

/** True while at least one browser/CLI is attached — the health alarm polls faster in this case (15s vs 60s). */
export function hasActiveEventClients(rt: SessionRuntime): boolean {
  return rt.sseWriters.size > 0;
}
