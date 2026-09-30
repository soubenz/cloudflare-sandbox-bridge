/**
 * Site feedback: the parts that do not need Cloudflare.
 *
 * Same shape as waitlist.ts: pure functions over a FormData-like object so
 * test/unit can exercise every rule, with worker.ts doing the I/O.
 */
import { HONEYPOT_FIELD, normaliseEmail, toSource, type FieldSource } from './waitlist';

export const FEEDBACK_PATH = '/feedback';
export const FEEDBACK_THANKS_PATH = '/feedback/thanks.html';
export const MESSAGE_MAX = 2000;

export type FeedbackError = 'rating' | 'message' | 'email' | 'slow' | 'down';

export interface Feedback {
  rating: number;
  message: string | null;
  email: string | null;
  source: string | null;
}

export type FeedbackParse =
  | { kind: 'feedback'; value: Feedback }
  | { kind: 'honeypot' }
  | { kind: 'invalid'; error: FeedbackError };

function text(form: FieldSource, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export function parseFeedback(form: FieldSource): FeedbackParse {
  if (text(form, HONEYPOT_FIELD) !== '') return { kind: 'honeypot' };

  const rawRating = text(form, 'rating');
  const rating = /^[1-5]$/.test(rawRating) ? Number(rawRating) : null;
  if (rating === null) return { kind: 'invalid', error: 'rating' };

  const message = text(form, 'message');
  if (message.length > MESSAGE_MAX) return { kind: 'invalid', error: 'message' };

  const rawEmail = text(form, 'email');
  const email = rawEmail === '' ? null : normaliseEmail(rawEmail);
  if (rawEmail !== '' && email === null) return { kind: 'invalid', error: 'email' };

  return {
    kind: 'feedback',
    value: { rating, message: message === '' ? null : message, email, source: toSource(text(form, 'source')) },
  };
}

export function feedbackErrorLocation(error: FeedbackError): string {
  return `${FEEDBACK_PATH}?e=${error}`;
}

export const INSERT_FEEDBACK_SQL = `INSERT INTO feedback_site (id, rating, message, email, country, source, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

export function feedbackParams(f: Feedback, id: string, country: string | null, now: number): unknown[] {
  return [id, f.rating, f.message, f.email, country, f.source, now];
}
