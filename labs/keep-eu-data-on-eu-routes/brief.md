# Keep EU data on EU routes

Customer support runs two different kinds of requests through the same
LiteLLM gateway:

- **`eu-data-only`** -- for requests carrying data that's tagged as
  EU-resident. This alias must never let that data reach a model provider
  outside the EU, for any reason, including a provider outage.
- **`global-support`** -- for everything else. This alias has no region
  restriction, and it should keep answering even when one region is down.

Right now, `eu-data-only` does not hold up its end of that promise. When
its EU provider is down, it still answers -- just from somewhere it isn't
supposed to.

## What is running

| Service | What it is |
|---|---|
| **litellm** | A real LiteLLM gateway (`workspace/gateway/config.yaml`). Its `model_list` has two aliases: `eu-data-only` and `global-support`. |
| `provider-us`, `provider-apac`, `provider-eu` | Three real, scripted model providers, one per region. Each has its own on-demand fault switch and its own request log -- see below. |
| `regional-proxy-eu` | A real second hop in front of `provider-eu`. Every alias reaching EU data goes through here, never straight to `provider-eu`. |
| **jaeger** tab | A real distributed-tracing backend. Every call, end to end, is traced into it over real OTLP -- a real, connected span chain from the gateway to wherever the request actually ends up. |

(Paths below are relative to `/workspace`, which is where your terminal
starts.)

## What you have

- `send_request.py` -- send one real request through either alias:
  `python3 send_request.py eu-data-only "..."` or
  `python3 send_request.py global-support "..."`.
- `traffic.py` -- send a stream of requests through one alias and see which
  region actually answered each one: `python3 traffic.py eu-data-only` or
  `python3 traffic.py global-support 20 0.2`.
- `eu_outage.py` -- put `provider-eu` into a real outage on demand
  (`python3 eu_outage.py on`) or end it (`python3 eu_outage.py off`). This
  talks straight to `provider-eu`, never to litellm or any config file.
- Every provider's own `/log` (e.g. `curl http://127.0.0.1:8971/log` for
  `provider-us`) -- a live, independent record of every request that
  provider actually received, whether it served it or refused it. This is
  never litellm's opinion of what happened; it's each provider's own.
- The jaeger tab (no login needed) -- click **Find Traces**, service
  `opalix-litellm`, to see the real, full hop-by-hop journey of any call
  you send.

After you change `workspace/gateway/config.yaml`, restart `litellm` from
the **Services panel** (left side) so it picks up your edit -- editing the
file alone doesn't restart the running process.

## See the problem yourself

```bash
python3 eu_outage.py on
python3 traffic.py eu-data-only
```

Every one of those requests should be refused -- `eu-data-only`'s whole
point is that its data never leaves the EU, and `provider-eu` is the only
place that's allowed to answer it. Look at what actually happens instead,
and check which provider's own `/log` recorded each of those requests.

```bash
python3 eu_outage.py off
```

## What "fixed" looks like

- **`eu-data-only` never answers from outside the EU.** Not occasionally,
  not as a fallback, not even while `provider-eu` is down. A request that
  can't reach `provider-eu` should be refused, clearly -- never silently
  handed to another region.
- **`global-support` keeps working exactly as it does today.** It should
  still fail over to another region when one is down, and still prefer its
  normal region the rest of the time. Whatever you change must be specific
  to `eu-data-only` -- it must not cost `global-support` its own
  resiliency.
- **A real request through `eu-data-only`, while everything is healthy,
  is still genuinely served by `provider-eu`** -- through
  `regional-proxy-eu`, the same real two-hop path as before.
- **Both aliases leave a real, checkable trail.** For any call through
  either alias, an auditor should be able to tell -- from a real jaeger
  trace, or from a provider's own request log, never from what the config
  file merely claims -- exactly which region actually served it (or
  refused it).

Nothing here is about hiding a region from anyone watching. `provider-eu`,
`provider-us` and `provider-apac` each keep an honest log of every request
they actually receive, and jaeger keeps an honest trace of every call's
real path. The point is that `eu-data-only`'s own trail should always show
the same region, and only that region -- proven, not just configured.
