# site

The public home page for opalix.ai. It is plain HTML and CSS with no build
step and no JavaScript. It deploys as a static-assets Cloudflare Worker,
separate from the dashboard and the sandbox API.

- `public/index.html` is the home page. It is responsive from phone width up.
- `public/styles.css` holds the whole visual system. The colour palette,
  "Cobalt and ice", is defined once as custom properties at the top.
- `public/404.html` catches links to pages that don't exist yet.

## Preview and deploy

```sh
npm run dev:site      # http://localhost:8789
npm run deploy:site   # needs a Cloudflare account
```

Deploying is not part of the CI workflow yet. Attach the opalix.ai route in
Cloudflare when the page should go live.

## Links still to wire

The page links to stable paths that don't exist yet. Until they do, they
show the 404 page.

| Path | Meant for |
|---|---|
| `/join` | Beta sign-up |
| `/signin` | Sign in |
| `/labs/duplicate-emails`, `/labs/weekend-bill` | The public page for each live lab |
| `/manager-note` | The one-page note an engineer forwards to a manager |
| `/pilot` | Team pilot request |
| `/feedback` | Beta feedback |
| `/privacy` | Privacy policy |
