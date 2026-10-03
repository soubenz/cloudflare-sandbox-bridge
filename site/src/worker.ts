/**
 * opalix-site: the public pages plus two form endpoints, the waitlist
 * (POST /api/waitlist) and site feedback (POST /feedback).
 *
 * Static files are served straight from assets. The Worker only sees
 * /api/* and /feedback (see "run_worker_first" in site/wrangler.jsonc), so
 * pages other than the feedback form never pay for a Worker invocation.
 * /try and /signin are redirects in public/_redirects, handled by assets.
 *
 * The form is a plain HTML POST that answers with a 303 redirect, so it
 * works with JavaScript off and needs no CORS.
 */
import {
  THANKS_PATH,
  errorLocation,
  parseSignup,
  UPSERT_SQL,
  upsertParams,
  type SignupError,
  type Plan,
} from './waitlist';
import {
  FEEDBACK_THANKS_PATH,
  feedbackErrorLocation,
  feedbackParams,
  INSERT_FEEDBACK_SQL,
  parseFeedback,
  type FeedbackError,
} from './feedback';

/** The Workers Rate Limiting binding; declared here to keep this file self-contained. */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WAITLIST_LIMIT?: RateLimiter;
  /** Set on PR preview versions (see .github/workflows/preview-site.yml). Never set in production. */
  PREVIEW?: string;
}

function seeOther(request: Request, path: string): Response {
  return Response.redirect(new URL(path, request.url).toString(), 303);
}

function back(request: Request, error: SignupError, plan?: Plan): Response {
  return seeOther(request, errorLocation(error, plan));
}

async function handleWaitlist(request: Request, env: Env): Promise<Response> {
  // Per-address limit, checked before any parsing or database work.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (env.WAITLIST_LIMIT) {
    const { success } = await env.WAITLIST_LIMIT.limit({ key: ip });
    if (!success) return back(request, 'slow');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back(request, 'email');
  }

  const parsed = parseSignup(form);
  // A bot that filled the hidden field is shown success and stored nowhere.
  if (parsed.kind === 'honeypot') return seeOther(request, THANKS_PATH);
  if (parsed.kind === 'invalid') return back(request, parsed.error, parsed.plan);

  // Preview versions share production's bindings, so they must never write
  // to the real waitlist. Everything up to here behaves exactly as live.
  if (env.PREVIEW) return seeOther(request, THANKS_PATH);

  const country = typeof request.cf?.country === 'string' ? request.cf.country : null;
  try {
    await env.DB.prepare(UPSERT_SQL)
      .bind(...upsertParams(parsed.value, country, Date.now()))
      .run();
  } catch (err) {
    // Never log the address itself.
    console.error('waitlist insert failed', err instanceof Error ? err.message : String(err));
    return back(request, 'down', parsed.value.plan);
  }

  // Same answer whether the email was new or already listed, so the form
  // cannot be used to find out who has signed up.
  return seeOther(request, THANKS_PATH);
}

function feedbackBack(request: Request, error: FeedbackError): Response {
  return seeOther(request, feedbackErrorLocation(error));
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  // Same per-address limit as the waitlist, on its own key so the two forms
  // do not spend each other's budget.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (env.WAITLIST_LIMIT) {
    const { success } = await env.WAITLIST_LIMIT.limit({ key: `feedback:${ip}` });
    if (!success) return feedbackBack(request, 'slow');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return feedbackBack(request, 'rating');
  }

  const parsed = parseFeedback(form);
  // A bot that filled the hidden field is shown success and stored nowhere.
  if (parsed.kind === 'honeypot') return seeOther(request, FEEDBACK_THANKS_PATH);
  if (parsed.kind === 'invalid') return feedbackBack(request, parsed.error);

  const country = typeof request.cf?.country === 'string' ? request.cf.country : null;
  try {
    await env.DB.prepare(INSERT_FEEDBACK_SQL)
      .bind(...feedbackParams(parsed.value, crypto.randomUUID(), country, Date.now()))
      .run();
  } catch (err) {
    // Never log the message or the address.
    console.error('feedback insert failed', err instanceof Error ? err.message : String(err));
    return feedbackBack(request, 'down');
  }
  return seeOther(request, FEEDBACK_THANKS_PATH);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/waitlist') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      return handleWaitlist(request, env);
    }
    // The Worker also sees GET /feedback (run_worker_first matches paths, not
    // methods); only POST is ours, the page itself is a static asset.
    if (pathname === '/feedback' && request.method === 'POST') return handleFeedback(request, env);
    if (pathname === '/feedback' && request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } });
    }
    if (pathname.startsWith('/api/')) return new Response('Not Found', { status: 404 });

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
