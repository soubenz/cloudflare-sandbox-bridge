/**
 * Typed HTTP client for the Opalix sandbox API. Shared between the CLI
 * commands and the integration test suite (test/integration/*.test.ts) so
 * both exercise the exact same request shapes — the whole point of "a
 * command-line client that stays useful forever, for testing every new
 * lab" from the product plan.
 */
export interface OpalixClientOptions {
  baseUrl: string;
  serviceKey?: string;
  sessionToken?: string;
}

export interface SessionCreateResponse {
  id: string;
  state: string;
  token: string;
  urls: {
    status: string;
    terminal: string;
    events: string;
    services: Record<string, string>;
  };
}

export interface ServiceRuntime {
  spec: { name: string; port?: number; ui: boolean };
  health: 'unknown' | 'healthy' | 'unhealthy';
  restarts: number;
}

export interface SessionStatus {
  meta: {
    id: string;
    state: string;
    lab_slug: string;
    expires_at?: number;
    started_at?: number;
  };
  services: Record<string, ServiceRuntime>;
  snapshots: Array<{ backup_id: string; created_at: number; reason: string }>;
  checks?: { run_id: string; results: Array<{ name: string; pass: boolean; message: string }> };
}

export class OpalixClient {
  constructor(private readonly opts: OpalixClientOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  get serviceKey(): string | undefined {
    return this.opts.serviceKey;
  }

  private authHeaders(useSession: boolean): Record<string, string> {
    if (useSession && this.opts.sessionToken) return { Authorization: `Bearer ${this.opts.sessionToken}` };
    if (this.opts.serviceKey) return { Authorization: `Bearer ${this.opts.serviceKey}` };
    return {};
  }

  private async request<T>(path: string, init: RequestInit = {}, useSession = false): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { ...this.authHeaders(useSession), ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  health(): Promise<{ ok: boolean }> {
    return this.request('/health');
  }

  listLabs(): Promise<Array<{ slug: string; version: string; title: string; type: string; family: string }>> {
    return this.request('/labs');
  }

  startSession(lab: string, userId: string): Promise<SessionCreateResponse> {
    return this.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lab, user_id: userId }) });
  }

  status(sessionId: string): Promise<SessionStatus> {
    return this.request(`/sessions/${sessionId}`, {}, true);
  }

  readFile(sessionId: string, path: string): Promise<{ content: string; encoding?: string }> {
    return this.request(`/sessions/${sessionId}/files/${path}`, {}, true);
  }

  writeFile(sessionId: string, path: string, content: string): Promise<{ ok: boolean }> {
    return this.request(`/sessions/${sessionId}/files/${path}`, { method: 'PUT', body: content }, true);
  }

  listFiles(sessionId: string, path = '/workspace'): Promise<{ files: unknown[] }> {
    return this.request(`/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`, {}, true);
  }

  deleteFile(sessionId: string, path: string): Promise<{ ok: boolean }> {
    return this.request(`/sessions/${sessionId}/files/${path}`, { method: 'DELETE' }, true);
  }

  /** The API allows one check run every 2 s per session; a quick lab's second run can land inside that, so wait and retry. */
  async runChecks(sessionId: string, only?: string[]): Promise<SessionStatus['checks']> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(`/sessions/${sessionId}/checks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ only }) }, true);
      } catch (err) {
        const m = /-> 429: .*checks_too_frequent.*retry_after_ms"?\D*(\d+)/.exec(String((err as Error).message));
        if (!m || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, Number(m[1]) + 250));
      }
    }
  }

  restartService(sessionId: string, name: string): Promise<ServiceRuntime> {
    return this.request(`/sessions/${sessionId}/services/${name}/restart`, { method: 'POST' }, true);
  }

  snapshot(sessionId: string): Promise<{ backup_id: string }> {
    return this.request(`/sessions/${sessionId}/snapshot`, { method: 'POST' }, true);
  }

  resume(sessionId: string): Promise<{ meta: { state: string }; token: string }> {
    return this.request(`/sessions/${sessionId}/resume`, { method: 'POST' }, true);
  }

  end(sessionId: string, snapshot = true): Promise<{ ok: boolean }> {
    return this.request(`/sessions/${sessionId}?snapshot=${snapshot ? '1' : '0'}`, { method: 'DELETE' }, true);
  }

  async publishLab(form: FormData): Promise<{ slug: string; version: string }> {
    const res = await fetch(`${this.opts.baseUrl}/labs/publish`, {
      method: 'POST',
      headers: this.authHeaders(false),
      body: form,
    });
    if (!res.ok) throw new Error(`publish failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as { slug: string; version: string };
  }

  poolStats(family: string): Promise<unknown> {
    return this.request(`/pools/${family}`);
  }

  primePool(family: string, target?: number): Promise<{ ok: boolean }> {
    return this.request(`/pools/${family}/prime`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) });
  }

  drainPool(family: string): Promise<{ ok: boolean }> {
    return this.request(`/pools/${family}/drain`, { method: 'POST' });
  }

  eventsUrl(sessionId: string): string {
    const url = new URL(`${this.opts.baseUrl}/sessions/${sessionId}/events`);
    if (this.opts.sessionToken) url.searchParams.set('token', this.opts.sessionToken);
    return url.toString();
  }

  terminalUrl(sessionId: string): string {
    const url = new URL(`${this.opts.baseUrl}/sessions/${sessionId}/terminal`);
    url.protocol = url.protocol.replace('http', 'ws');
    if (this.opts.sessionToken) url.searchParams.set('token', this.opts.sessionToken);
    return url.toString();
  }

  serviceUrl(sessionId: string, name: string): string {
    const url = new URL(`${this.opts.baseUrl}/sessions/${sessionId}/services/${name}/`);
    if (this.opts.sessionToken) url.searchParams.set('token', this.opts.sessionToken);
    return url.toString();
  }
}
