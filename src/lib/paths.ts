import { ApiError } from './errors';

/** Everything a session may touch through the files API lives here. */
export const WORKSPACE_ROOT = '/workspace';

/**
 * Turns a client-supplied file path into an absolute path that is provably
 * inside `/workspace`.
 *
 * This is not belt-and-braces. Hono's router matches `:path{.+}` against the
 * *encoded* path and decodes the captured value afterwards, so `%2F` and
 * `%2E` survive routing and arrive as real separators and dots:
 * `files/..%2F..%2Fetc%2Fpasswd` reaches the handler as `../../etc/passwd`,
 * and `/workspace/${path}` then points at `/etc/passwd`. Unencoded `../`
 * is normalised away by the URL parser long before routing, which is why
 * the hole was invisible — the obvious probe 404s.
 *
 * `/etc/opalix/session.env` (which holds the session's LLM token) and
 * `/etc/profile.d/opalix.sh` (sourced by every login shell) are both
 * reachable that way with a session token, so this is a read *and* a write
 * boundary.
 *
 * Rejects rather than sanitises: silently rewriting `../../etc/passwd` to
 * `etc/passwd` would hand back the wrong file and look like it worked.
 */
export function workspacePath(raw: string): string {
  if (raw.includes('\0')) throw ApiError.badRequest('bad_path', 'Path contains a null byte');

  const relative = raw.startsWith(`${WORKSPACE_ROOT}/`)
    ? raw.slice(WORKSPACE_ROOT.length + 1)
    : raw === WORKSPACE_ROOT
      ? ''
      : raw;

  if (relative.startsWith('/')) {
    throw ApiError.badRequest('bad_path', `Path must be inside ${WORKSPACE_ROOT}`);
  }

  const segments: string[] = [];
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw ApiError.badRequest('bad_path', `Path must be inside ${WORKSPACE_ROOT}`);
    }
    segments.push(segment);
  }

  return segments.length === 0 ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${segments.join('/')}`;
}
