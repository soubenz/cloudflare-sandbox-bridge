import { getSandbox } from '@cloudflare/sandbox';
import type { SandboxProcess, Terminal, DirectoryBackup, ExecOptions, CreateTerminalOptions, BackupOptions } from '@cloudflare/sandbox';
import type { Env, Family } from '../env';
import { sandboxNamespace } from '../families/registry';
import { fromSdkError } from '../lib/errors';

/**
 * `ListFilesResult` / `FileEncoding` aren't re-exported from the SDK's
 * top-level module (only their `*Options` siblings are); these mirror the
 * documented shapes locally rather than reaching into the package's
 * internal chunk files, which are not a stable import path.
 */
export interface FileInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}
export interface ListFilesResult {
  files: FileInfo[];
  count: number;
}
export type FileEncoding = 'utf-8' | 'base64';

/**
 * The only interface session/* modules talk to the container through.
 * `CloudflareBackend` (below) wraps the SDK; a later `ClusterBackend`
 * (Hetzner or GCP, k3s + Kata over a tunnel — see the pricing review in the
 * plan) implements the same interface with no change to any route,
 * manifest field, or CLI command. `FakeSandbox` in tests implements it too.
 *
 * Re-exports the SDK's own `SandboxProcess` / `Terminal` / `DirectoryBackup`
 * shapes rather than wrapping every field — those are already
 * backend-agnostic-shaped (id, kill, waitForPort, connect, resize...), so
 * duplicating them here would just be indirection with no seam behind it.
 * The seam is at the call surface (this interface), not at every value type.
 */
export interface Backend {
  /** Confirms the container is up, retrying through ContainerUnavailableError. Called first in every session start/resume/recover. */
  ensureRunning(): Promise<void>;
  exec(argv: readonly string[], options?: ExecOptions): Promise<SandboxProcess>;
  getProcess(id: string): Promise<SandboxProcess | null>;
  readFile(path: string): Promise<{ content: string; encoding?: FileEncoding }>;
  writeFile(path: string, content: string | ReadableStream<Uint8Array>): Promise<void>;
  listFiles(path: string): Promise<ListFilesResult>;
  deleteFile(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  createTerminal(options: CreateTerminalOptions): Promise<Terminal>;
  getTerminal(id: string): Promise<Terminal | null>;
  wsConnect(request: Request, port: number): Promise<Response>;
  containerFetch(request: Request, port: number): Promise<Response>;
  createBackup(options: BackupOptions): Promise<DirectoryBackup>;
  restoreBackup(backup: DirectoryBackup): Promise<{ success: boolean }>;
  setAllowedHosts(hosts: string[]): Promise<void>;
  destroy(): Promise<void>;
}

/** SandboxCommand is a non-empty tuple; callers pass a plain string[] (from manifest.argv etc.), so this is the one place that validates and narrows it. */
function asCommand(argv: readonly string[]): readonly [string, ...string[]] {
  if (argv.length === 0) throw new Error('exec() argv must not be empty');
  return argv as readonly [string, ...string[]];
}

/** Wraps a call so ContainerUnavailableError retries (per retryAfterMs) instead of failing the whole operation. */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const name = (err as { name?: string } | undefined)?.name;
      if (name !== 'ContainerUnavailableError') throw fromSdkError(err);
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(retryAfterMs, 10_000)));
    }
  }
  throw fromSdkError(lastErr);
}

export function cloudflareBackend(env: Env, family: Family, sandboxId: string): Backend {
  const ns = sandboxNamespace(env, family);
  const sb = getSandbox(ns, sandboxId, {
    sleepAfter: '15m', // dead-man's switch; the Session DO's health alarm is what actually keeps this warm
  });

  return {
    async ensureRunning() {
      await withRetry(() => sb.exec(['true']));
    },
    exec(argv, options) {
      return withRetry(() => sb.exec(asCommand(argv), options));
    },
    getProcess(id) {
      return withRetry(() => sb.getProcess(id));
    },
    async readFile(path) {
      const result = await withRetry(() => sb.readFile(path));
      return { content: result.content, encoding: result.encoding };
    },
    async writeFile(path, content) {
      await withRetry(() => sb.writeFile(path, content));
    },
    async listFiles(path) {
      const result = await withRetry(() => sb.listFiles(path));
      return { files: result.files as unknown as FileInfo[], count: result.count };
    },
    async deleteFile(path) {
      await withRetry(() => sb.deleteFile(path));
    },
    async mkdir(path, options) {
      await withRetry(() => sb.mkdir(path, options));
    },
    createTerminal(options) {
      return withRetry(() => sb.createTerminal(options));
    },
    getTerminal(id) {
      return withRetry(() => sb.getTerminal(id));
    },
    wsConnect(request, port) {
      return withRetry(() => sb.wsConnect(request, port));
    },
    containerFetch(request, port) {
      return withRetry(() => sb.containerFetch(request, port));
    },
    createBackup(options) {
      return withRetry(() => sb.createBackup(options));
    },
    restoreBackup(backup) {
      return withRetry(() => sb.restoreBackup(backup));
    },
    async setAllowedHosts(hosts) {
      await withRetry(() => sb.setAllowedHosts(hosts));
    },
    async destroy() {
      await sb.destroy();
    },
  };
}
