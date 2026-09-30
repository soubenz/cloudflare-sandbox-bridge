import type { Backend } from '../../src/session/backend';

/** A recorded call: method name plus the arguments it was invoked with. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

type Result = { value?: unknown; error?: unknown };

/**
 * Programmable stand-in for a container process (SandboxProcess). Every
 * method records its call in `calls` and consumes queued results in order;
 * once the queue is empty it falls back to a default (resolve undefined,
 * or an empty stream for output/logs).
 */
export class FakeProcess {
  id: string;
  pid: number;
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, Result[]>();

  constructor(id = 'proc-1', pid = 100) {
    this.id = id;
    this.pid = pid;
  }

  /** Queue a resolved value for the next un-programmed call of `method`. */
  resolveNext(method: string, value?: unknown): this {
    this.queue(method).push({ value });
    return this;
  }
  /** Queue a rejection for the next un-programmed call of `method`. */
  rejectNext(method: string, error: unknown): this {
    this.queue(method).push({ error });
    return this;
  }
  /** Args of every recorded call to `method`, in order. */
  callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  private queue(method: string): Result[] {
    let q = this.queues.get(method);
    if (!q) this.queues.set(method, (q = []));
    return q;
  }
  private invoke(method: string, args: unknown[], fallback?: () => unknown): Promise<unknown> {
    this.calls.push({ method, args });
    const next = this.queue(method).shift();
    if (next?.error !== undefined) return Promise.reject(next.error);
    if (next) return Promise.resolve(next.value);
    return Promise.resolve(fallback ? fallback() : undefined);
  }
  private emptyStream(): ReadableStream {
    return new ReadableStream({ start: (c) => c.close() });
  }

  kill(signal?: number): Promise<unknown> {
    return this.invoke('kill', [signal]);
  }
  waitForExit(options?: { timeout?: number }): Promise<unknown> {
    return this.invoke('waitForExit', [options]);
  }
  waitForPort(port: number, options?: unknown): Promise<unknown> {
    return this.invoke('waitForPort', [port, options]);
  }
  output(...args: unknown[]): Promise<unknown> {
    return this.invoke('output', args, () => ({ stdout: '', stderr: '' }));
  }
  logs(options?: unknown): Promise<unknown> {
    return this.invoke('logs', [options], () => this.emptyStream());
  }
}

/**
 * Minimal in-memory Backend. Every method records `{ method, args }` in
 * `calls` and consumes results queued with `resolveNext` / `rejectNext`
 * (FIFO per method); with nothing queued it returns a benign default.
 * `exec` and `getProcess` hand out `FakeProcess` instances: register the one
 * `getProcess(id)` should return with `addProcess`, and queue what `exec`
 * should hand back with `resolveNext('exec', proc)` (default: a fresh
 * FakeProcess, recorded in `execProcesses`).
 */
export class FakeBackend {
  readonly calls: RecordedCall[] = [];
  readonly processes = new Map<string, FakeProcess>();
  readonly execProcesses: FakeProcess[] = [];
  private readonly queues = new Map<string, Result[]>();

  addProcess(proc: FakeProcess): FakeProcess {
    this.processes.set(proc.id, proc);
    return proc;
  }
  resolveNext(method: string, value?: unknown): this {
    this.queue(method).push({ value });
    return this;
  }
  rejectNext(method: string, error: unknown): this {
    this.queue(method).push({ error });
    return this;
  }
  callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }
  /** The fake typed as the real interface, for passing into code under test. */
  asBackend(): Backend {
    return this as unknown as Backend;
  }

  private queue(method: string): Result[] {
    let q = this.queues.get(method);
    if (!q) this.queues.set(method, (q = []));
    return q;
  }
  private invoke(method: string, args: unknown[], fallback?: () => unknown): Promise<unknown> {
    this.calls.push({ method, args });
    const next = this.queue(method).shift();
    if (next?.error !== undefined) return Promise.reject(next.error);
    if (next) return Promise.resolve(next.value);
    return Promise.resolve(fallback ? fallback() : undefined);
  }

  ensureRunning() {
    return this.invoke('ensureRunning', []);
  }
  exec(argv: readonly string[], options?: unknown) {
    return this.invoke('exec', [argv, options], () => {
      const proc = new FakeProcess(`exec-proc-${this.execProcesses.length + 1}`, 200 + this.execProcesses.length);
      this.execProcesses.push(proc);
      this.processes.set(proc.id, proc);
      return proc;
    });
  }
  getProcess(id: string) {
    return this.invoke('getProcess', [id], () => this.processes.get(id) ?? null);
  }
  readFile(path: string) {
    return this.invoke('readFile', [path], () => ({ content: '' }));
  }
  writeFile(path: string, content: unknown) {
    return this.invoke('writeFile', [path, content]);
  }
  listFiles(path: string) {
    return this.invoke('listFiles', [path], () => ({ files: [], count: 0 }));
  }
  deleteFile(path: string) {
    return this.invoke('deleteFile', [path]);
  }
  mkdir(path: string, options?: unknown) {
    return this.invoke('mkdir', [path, options]);
  }
  createTerminal(options: unknown) {
    return this.invoke('createTerminal', [options]);
  }
  getTerminal(id: string) {
    return this.invoke('getTerminal', [id], () => null);
  }
  wsConnect(request: Request, port: number) {
    return this.invoke('wsConnect', [request, port]);
  }
  containerFetch(request: Request, port: number) {
    return this.invoke('containerFetch', [request, port], () => new Response('ok'));
  }
  createBackup(options: unknown) {
    return this.invoke('createBackup', [options]);
  }
  restoreBackup(backup: unknown) {
    return this.invoke('restoreBackup', [backup], () => ({ success: true }));
  }
  setEnvVars(vars: Record<string, string>) {
    return this.invoke('setEnvVars', [vars]);
  }
  setAllowedHosts(hosts: string[]) {
    return this.invoke('setAllowedHosts', [hosts]);
  }
  destroy() {
    return this.invoke('destroy', []);
  }
}
