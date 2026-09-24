# Gateway image smoke test

Two services run in this container:

- **prometheus** on :9090, scraping itself, proxied at the session's
  `/services/prometheus/` path.
- **grafana** on :3001 (not 3000 — that port belongs to the sandbox control
  plane), proxied at `/services/grafana/`.

Both serve their entire HTTP surface under the session's service path, so
calls from inside the container need that prefix too: `$PROM_URL` and
`$GRAFANA_URL` in the environment already carry it.

`litellm` and `locust` are installed in the image but are not started here.
