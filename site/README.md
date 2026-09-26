# site

The public home page for opalix.ai. It is plain HTML and CSS with no build
step, plus one small Worker endpoint for the waitlist. It deploys as its own
Cloudflare Worker, separate from the dashboard and the sandbox API.

- `public/index.html` is the home page. It is responsive from phone width up.
- `public/styles.css` holds the whole visual system. The colour palette,
  "Cobalt and ice", is defined once as custom properties at the top.
- `public/waitlist.html` and `public/waitlist/thanks.html` are the waitlist
  form and its confirmation page.
- `src/worker.ts` handles `POST /api/waitlist`. Everything else is served
  straight from `public/` without running the Worker.
- `public/404.html` catches links to pages that don't exist yet.
- `public/privacy.html` is the privacy policy. It describes exactly what the
  waitlist stores, so change it before the Worker starts storing anything new.
- `public/fonts/` holds the three variable fonts (Funnel Display, Funnel Sans,
  JetBrains Mono), copied from the `@fontsource-variable` dev dependencies.
  They are self-hosted so pages make no requests to anyone but this site.
  Their licence is `public/fonts/OFL.txt`.

## Waitlist

The form posts to `/api/waitlist`, which answers with a redirect, so it
works without JavaScript.

- **Storage.** One row per email in the `waitlist` table of the `opalix` D1
  database (`migrations/0004_waitlist.sql`). Signing up again updates the
  plan and role but keeps the original signup time and source.
- **Fields.** Email, plan (individual or team), an optional role, the
  country Cloudflare reports, and which button sent them (`hero` or
  `pricing`). No IP address is stored.
- **Spam.** A hidden honeypot field, and a limit of five signups per minute
  per address using the Workers Rate Limiting binding.
- **Not yet.** No confirmation email: Cloudflare can only send once
  opalix.ai's DNS is on Cloudflare. No export on the site: that belongs in
  the admin panel.

Until the admin panel exists, read the list from the command line:

```sh
npx wrangler d1 execute opalix --remote \
  --command "SELECT email, plan, role, source, datetime(created_at/1000, 'unixepoch') AS joined FROM waitlist ORDER BY created_at"
```

## Working on the site

Work happens on the `dev-landing-page` branch, never directly on main.

1. Commit to `dev-landing-page` and open a pull request to main.
2. `.github/workflows/preview-site.yml` uploads a preview for the PR at
   `https://pr-<number>-opalix-site.<account-subdomain>.workers.dev` and
   comments the link on the PR. It updates on every push. The preview is a
   Worker version, not a deployment, so production is untouched. Its
   waitlist form validates but stores nothing (`PREVIEW=true`), and D1
   migrations are not applied until merge.
3. Merging the PR deploys production through `deploy-site.yml`.

## Preview and deploy

```sh
npm run dev:site      # http://localhost:8789
npm run deploy:site   # needs a Cloudflare account
```

Every push to main that touches `site/` deploys it through
`.github/workflows/deploy-site.yml`. Until opalix.ai's DNS is on Cloudflare,
the site lives at its temporary `workers.dev` address, which the workflow run
prints in its summary. That copy sends `X-Robots-Tag: noindex` (from
`public/_headers`) so search engines skip it.

To move to opalix.ai: point the domain's nameservers at Cloudflare, add
opalix.ai and www.opalix.ai as custom domains on the `opalix-site` Worker,
then remove the `X-Robots-Tag: noindex` rule from `public/_headers` (keep
the font caching rule).

## Links still to wire

The page links to stable paths that don't exist yet. Until they do, they
show the 404 page.

| Path | Meant for |
|---|---|
| `/try` | The free lab |
| `/signin` | Sign in |
| `/feedback` | Beta feedback |

## Before promoting the site

- Replace `[COMPANY NAME]` and `[REGISTERED ADDRESS]` in `public/privacy.html`
  with the legal entity that runs Opalix.
- Make sure privacy@opalix.ai delivers. Once opalix.ai's DNS is on
  Cloudflare, Email Routing can forward it to an existing inbox for free.
- Have someone qualified review the privacy page. It matches what the site
  does, but it isn't legal advice.
