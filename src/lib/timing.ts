/**
 * Where a request's time goes, as a `Server-Timing` header DevTools shows
 * under Network -> Timing. The file routes carry it so a slow open can be
 * split into the parts that cost: the Worker -> Session DO hop, the session
 * state read, and the container exec (starting the process, then waiting
 * for its output).
 *
 * `Date.now()` in a Worker only advances across I/O, which is exactly what
 * is being measured here; CPU time between awaits reads as zero.
 */
export type Phases = Record<string, number>;

export class OpTiming {
  private readonly t0 = Date.now();
  private readonly phases: Phases = {};

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.phases[name] = (this.phases[name] ?? 0) + (Date.now() - start);
    }
  }

  /** The phases so far plus `total` (since construction): a plain object, so it crosses the DO's RPC boundary. */
  done(total = 'do'): Phases {
    return { ...this.phases, [total]: Date.now() - this.t0 };
  }
}

/** What each phase name means in DevTools. Unknown names are still listed, without a description. */
const DESCRIPTIONS: Record<string, string> = {
  running: 'session state read',
  exec: 'container: start the process',
  output: 'container: run it and collect its output',
  do: 'Session DO, in all',
  total: 'Worker, in all',
};

const TOKEN = /^[A-Za-z0-9_-]+$/;

/** `exec;dur=210;desc="container: start the process", ...`, in the order given. */
export function serverTimingHeader(phases: Phases): string {
  return Object.entries(phases)
    .filter(([name, ms]) => TOKEN.test(name) && Number.isFinite(ms))
    .map(([name, ms]) => {
      const desc = DESCRIPTIONS[name];
      return `${name};dur=${Math.max(0, Math.round(ms))}${desc ? `;desc="${desc}"` : ''}`;
    })
    .join(', ');
}

/** `body` as JSON with the DO's phases and the Worker's own total (since `started`) in a Server-Timing header. */
export function timedJson(body: unknown, started: number, phases: Phases): Response {
  const res = Response.json(body);
  res.headers.set('Server-Timing', serverTimingHeader({ ...phases, total: Date.now() - started }));
  return res;
}
