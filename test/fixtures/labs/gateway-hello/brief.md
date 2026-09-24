# The observability stack, already running

Nothing is broken here. Prometheus and Grafana are up, wired together, and
proxied into this console — this lab is a tour of how that fits together,
so that when a later lab breaks one of them you know what "working" looked
like.

## What is running

| Service | Port | What it is doing |
|---|---|---|
| `prometheus` | 9090 | Scraping itself, once every few seconds |
| `grafana` | 3001 | Anonymous access, Prometheus pre-provisioned as a datasource |

Both appear as tabs above the terminal. They are not on the public
internet: the proxy reaches them inside your container, and only your
session token gets through.

## The thing worth understanding

A service embedded under a path prefix has to be told about that prefix, or
every link and asset it generates points at the wrong place. Each service
handles this differently:

- Prometheus takes `--web.external-url`, which also sets its route prefix.
- Grafana takes `GF_SERVER_ROOT_URL` plus `GF_SERVER_SERVE_FROM_SUB_PATH`.

Both are set for you in `manifest.yaml`, using the `{{service.prefix}}`
template. Open the **prometheus** tab and look at the address bar: the path
is `/sessions/{id}/services/prometheus/`, and Prometheus is serving from
there rather than from `/`.

## Try this

1. Open the **prometheus** tab, go to *Status → Targets*. The `prometheus`
   job should read `UP`. That is Prometheus scraping itself.
2. Open the **grafana** tab. It loads anonymously as an admin — no login,
   because a lab should not make you type a password.
3. In the **Terminal**, confirm what the container actually has:

   ```bash
   which litellm locust tmux
   curl -s "$PROM_URL/-/healthy"
   ```

## Checking your work

**Run checks** verifies the stack is genuinely serving rather than merely
running: Prometheus answers and its self-scrape is up, Grafana reports
healthy, and the gateway tooling is present.

You do not have to change anything for these to pass — that is the point of
this one.
