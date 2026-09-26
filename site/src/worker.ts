/**
 * opalix-site: the public home page plus one endpoint, the waitlist.
 *
 * Static files are served straight from assets. The Worker only sees
 * /api/* (see "run_worker_first" in site/wrangler.jsonc), so the page itself
 * never pays for a Worker invocation.
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

/** The Workers Rate Limiting binding; declared here to keep this file self-contained. */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WAITLIST_LIMIT?: RateLimiter;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/waitlist') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      return handleWaitlist(request, env);
    }
    if (pathname.startsWith('/api/')) return new Response('Not Found', { status: 404 });

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
