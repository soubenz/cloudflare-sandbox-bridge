import { ApiError } from '../lib/errors';
import { areaById } from './areas';
import type { StartingLevel } from './types';

/** Request parsing for the profile routes: pure, so the 400s are testable without a router. */

export const MAX_USER_ID_LENGTH = 128;

/** A user id is whatever the app backend uses; the route only rejects what cannot be one. Throws 400 `bad_user_id`. */
export function parseUserId(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.length > MAX_USER_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw ApiError.badRequest('bad_user_id', `the user id must be 1-${MAX_USER_ID_LENGTH} characters with no control characters`);
  }
  return raw;
}

const STARTING: readonly StartingLevel[] = ['new', 'ok', 'strong'];

/**
 * `?starting=gateway:ok,mcp:new`: the learner's onboarding-quiz result, which
 * the console holds in the browser. It is echoed back as each skill's
 * `starting_level` and never scored. Entries naming an unknown area or level
 * are ignored rather than failing the profile read.
 */
export function parseStartingLevels(raw: string | undefined): Record<string, StartingLevel> | undefined {
  if (!raw) return undefined;
  const out: Record<string, StartingLevel> = {};
  for (const part of raw.split(',')) {
    const [area, level] = part.split(':').map((s) => s.trim());
    if (area && level && areaById(area) && (STARTING as readonly string[]).includes(level)) out[area] = level as StartingLevel;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
