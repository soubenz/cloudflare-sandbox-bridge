# Prove where one request's data went

Nothing is broken; this is a tour: a gateway, three "regional" model
deployments behind it, and a tracing backend watching every hop. You send
a request, then prove -- from the system's own log and trace, not from a
config file -- where its data actually went.

## What is running

| Service | What it is |
|---|---|
| **litellm** | A LiteLLM gateway with three aliases, `support-us`, `support-apac`, `support-eu`: "regional" deployments of the same fake model, each tagged with its own `region` in `model_info`. |
| `support-us`, `support-apac` | Each routes straight to its own regional fake provider: one hop past the gateway. |
| `support-eu` | Routes through a **regional proxy** first, which then calls the real eu provider: two hops past the gateway. |
| **jaeger** tab | Every call is traced into it as one connected span chain, from the gateway to wherever the request ends up. |
| LiteLLM's own log | Every call is also logged in the Postgres table `LiteLLM_SpendLogs`: `model_group` (alias), `api_base` (the *first* hop's destination), `request_id`. A second, independent view. |

## Send a request

```bash
python3 -B /workspace/send_request.py support-eu "a question a customer asked"
```

(`support-us` and `support-apac` work the same way.) The response `id`,
like `chatcmpl-fake-eu-3c0400b8981d`, is your thread: it is the
`opalix.response_id` on the final provider span and the `request_id`
LiteLLM logged.

## Look at both views

**In Jaeger** (no login): **Find Traces**, service `opalix-litellm`, open
the trace closest to when you sent the request, expand every row, and look at:

- Which services appear in it: two for `support-us` (`opalix-litellm`,
  `opalix-provider-us`); `support-eu` has a second hop in the middle.
- The `opalix.region` tag on every span that carries one. Do they all
  agree, or does the request reach a region you didn't ask for?
- The `opalix.response_id` on the final provider span (it matches your `id`).

**In LiteLLM's log** (`psql`):

```bash
psql -h 127.0.0.1 -p 5432 -U postgres -c \
  "select request_id, model_group, api_base from \"LiteLLM_SpendLogs\" where request_id = '<the id you got back>';"
```

For `support-eu`, `api_base` is the *regional proxy*, not the provider two
hops down: the log stops at the first hop, and only the trace shows the
rest.

## Answer these

Send a request through `support-us` and one through `support-eu`, then
answer from what those traces show *right now*:

1. Which single region does a `support-us` trace show the data reaching
   (the `opalix.region` tag on its provider span)?
2. How many distinct services' spans appear in a `support-eu` trace,
   counting the gateway itself?
3. Does a `support-eu` request ever touch a region other than the one
   `support-eu` is declared to be in (its live `model_info.region`)?
   `true` if every region tag agrees with the declared region, `false` if
   any hop disagrees.

Write them into `/workspace/answers.json`, which starts as:

```json
{
  "support_us_region_reached": null,
  "support_eu_hop_count": null,
  "support_eu_stays_in_declared_region": null
}
```

Replace each `null`: a region string exactly as the trace spells it, a
number, and `true` or `false`.

## Checking your work

| Check | Passes when |
|---|---|
| `services-are-up` | LiteLLM and Jaeger are reachable, and all three aliases report a live `model_info` `region`. |
| `answers-match-live-traces` | Your three answers match what a fresh request through `support-us` and one through `support-eu` show *right now*, checked live against Jaeger's v3 API and LiteLLM's spend log, never a fixed key. |

The second check fires its own requests each time and reads only your
three values from the workspace.
