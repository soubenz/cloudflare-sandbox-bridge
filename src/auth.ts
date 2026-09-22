import type { Env } from './env';
import { ApiError } from './lib/errors';

export interface SessionTokenPayload {
  sid: string;
  uid: string;
  exp: number; // unix seconds
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64url(new Uint8Array(sig));
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToString(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return bin;
}

/**
 * Mints a short-lived session token for browser-facing endpoints (terminal,
 * events, service proxy). The token carries no secret data — it just proves
 * the holder was handed it by `POST /sessions`, so those routes never need
 * the service key. `exp` should be `expires_at + 10 minutes` so a session
 * that is about to hard-timeout doesn't lock its own browser client out
 * mid-check.
 */
export async function mintSessionToken(env: Env, payload: SessionTokenPayload): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(env.SESSION_TOKEN_SECRET, body);
  return `${body}.${sig}`;
}

export async function verifySessionToken(env: Env, token: string): Promise<SessionTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 2) throw ApiError.unauthorized('Malformed session token');
  const [body, sig] = parts as [string, string];
  const expectedSig = await hmac(env.SESSION_TOKEN_SECRET, body);
  if (!timingSafeEqual(sig, expectedSig)) throw ApiError.unauthorized('Invalid session token signature');
  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(base64urlToString(body));
  } catch {
    throw ApiError.unauthorized('Malformed session token payload');
  }
  if (typeof payload.sid !== 'string' || typeof payload.uid !== 'string' || typeof payload.exp !== 'number') {
    throw ApiError.unauthorized('Malformed session token payload');
  }
  if (payload.exp * 1000 < Date.now()) throw ApiError.unauthorized('Session token expired');
  return payload;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC token the container presents to the LLM Worker so it can't be impersonated. Not a JWT: just sid + signature. */
export async function mintLlmToken(env: Env, sessionId: string): Promise<string> {
  const sig = await hmac(env.SESSION_TOKEN_SECRET, `llm:${sessionId}`);
  return sig;
}

export type AuthContext =
  | { kind: 'service' }
  | { kind: 'session'; sid: string; uid: string };

/** Service callers (app backend, CLI) send the static bearer key. */
export function requireServiceAuth(request: Request, env: Env): void {
  const header = request.headers.get('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token || !timingSafeEqual(token, env.SANDBOX_API_KEY)) {
    throw ApiError.unauthorized('Missing or invalid service key');
  }
}

/**
 * Browser-facing routes accept a service key OR a session token (bearer,
 * `?token=`, or the `opx_s_{id}` cookie set by the service proxy). Returns
 * which principal authenticated, so callers can check the token's `sid`
 * matches the session in the URL.
 */
export async function requireBrowserAuth(request: Request, env: Env, sessionId: string): Promise<AuthContext> {
  const header = request.headers.get('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (bearer && timingSafeEqual(bearer, env.SANDBOX_API_KEY)) return { kind: 'service' };

  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token') ?? undefined;
  const cookieToken = readCookie(request, `opx_s_${sessionId}`);
  const token = bearer ?? queryToken ?? cookieToken;
  if (!token) throw ApiError.unauthorized('Missing session token');

  const payload = await verifySessionToken(env, token);
  if (payload.sid !== sessionId) throw ApiError.unauthorized('Session token does not match this session');
  return { kind: 'session', sid: payload.sid, uid: payload.uid };
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
