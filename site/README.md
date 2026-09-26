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

Every push to main that touches `site/` deploys it through
`.github/workflows/deploy-site.yml`. Until opalix.ai's DNS is on Cloudflare,
the site lives at its temporary `workers.dev` address, which the workflow run
prints in its summary. That copy sends `X-Robots-Tag: noindex` (from
`public/_headers`) so search engines skip it.

To move to opalix.ai: point the domain's nameservers at Cloudflare, add
opalix.ai and www.opalix.ai as custom domains on the `opalix-site` Worker,
then delete `public/_headers`.

## Links still to wire

The page links to stable paths that don't exist yet. Until they do, they
show the 404 page.

| Path | Meant for |
|---|---|
| `/try` | The free lab |
| `/waitlist` | Waitlist for the other labs and the paid plans |
| `/signin` | Sign in |
| `/feedback` | Beta feedback |
| `/privacy` | Privacy policy |
