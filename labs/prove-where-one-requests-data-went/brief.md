# Prove where one request's data went

Nothing is broken here. This is a tour: a real gateway, three real
"regional" model deployments behind it, and a real distributed-tracing
backend watching every hop. You send a request yourself, then prove -- from
the system's own real logs and its own real trace, not from what a config
file merely claims -- exactly where its data actually went.

## What is running

| Service | What it is |
|---|---|
| **litellm** | A real LiteLLM gateway. Its `model_list` has three aliases: `support-us`, `support-apac`, `support-eu` -- three "regional" deployments of the same fake model, each tagged with its own `region` in LiteLLM's own `model_info`. |
| `support-us`, `support-apac` | Each routes straight to its own regional fake provider. One real hop past the gateway. |
| `support-eu` | Routes through a **regional proxy** first, which itself then calls the real eu provider. Two real hops past the gateway, not one. |
| **jaeger** tab | A real Jaeger backend. Every one of the calls above is traced into it over real OTLP, with a real, correctly-connected parent-child span chain all the way from the gateway to wherever the request actually ends up -- never a hand-rolled trace id. |
| LiteLLM's own log | Every call is also logged the normal way LiteLLM logs any call, in `LiteLLM_SpendLogs` (a real Postgres table) -- `model_group` (which alias), `api_base` (the *first* hop's destination), `request_id`. This is a second, independent view of the same request. |

## Send a request

From a terminal:

```bash
python3 -B /workspace/send_request.py support-eu "a question a customer asked"
```

(`support-us` and `support-apac` work the same way.) The response carries
an `id` -- something like `chatcmpl-fake-eu-3c0400b8981d`. That id is your
thread to pull on: it is a real attribute on the span the request's own
final provider hop produced (`opalix.response_id`), and it is the literal
`request_id` LiteLLM itself logged for that exact call.

## Look at both views

**In Jaeger** (the jaeger tab, no login needed): click **Find Traces**,
service `opalix-litellm`, and open the trace whose root span is closest to
when you just sent your request. Expand every row. Look at:

- Which services appear in it (each has its own row prefix in the service
  picker, and its own colour in the waterfall) -- for `support-us` you
  should see two: `opalix-litellm` and `opalix-provider-us`. For
  `support-eu` you should see three, because a real second hop is in the
  middle.
- The `opalix.region` tag on every span that carries one. Does every single
  region tag in the trace agree with each other, or does the request ever
  actually reach a region other than the one you asked for?
- The `opalix.response_id` tag on the final provider span -- it should
  match the `id` your own request got back.

**In LiteLLM's own log** (a terminal, `psql`):

```bash
psql -h 127.0.0.1 -p 5432 -U postgres -c \
  "select request_id, model_group, api_base from \"LiteLLM_SpendLogs\" where request_id = '<the id you got back>';"
```

Notice what this view does and doesn't tell you: `model_group` confirms
which alias you called, and `api_base` is the address LiteLLM itself
called -- but for `support-eu`, that address is the *regional proxy*, not
the real provider two hops down. LiteLLM's own log stops at the first hop;
only the trace shows you the rest of the journey.

## Answer these

Send a real request through `support-us` and a real request through
`support-eu`, then answer, from what those two real traces actually show
*right now*:

1. Which single region does a `support-us` request's trace actually show
   the data reaching (the `opalix.region` tag on its provider span)?
2. How many distinct services' spans appear in a `support-eu` request's
   trace (count every service that shows up in it, including the gateway
   itself)?
3. Does a `support-eu` request ever actually touch a region other than the
   one `support-eu` itself is declared to be in (check
   `support-eu`'s own `model_info.region`, live, against every
   `opalix.region` tag the trace actually carries)? Answer `true` if every
   region tag in the trace agrees with `support-eu`'s declared region,
   `false` if even one hop's tag disagrees.

Write your answers into `/workspace/answers.json`, which starts out as:

```json
{
  "support_us_region_reached": null,
  "support_eu_hop_count": null,
  "support_eu_stays_in_declared_region": null
}
```

Replace each `null`: the first with a region name (a string, exactly as
the trace's own tag spells it), the second with a number, the third with
`true` or `false`.

## Checking your work

| Check | Passes when |
|---|---|
| `services-are-up` | LiteLLM and Jaeger are both reachable, and all three aliases report a `region` in their own live `model_info` |
| `answers-match-live-traces` | Your three answers match what a fresh, real request through `support-us` and a fresh, real request through `support-eu` actually show *right now*, checked live against Jaeger's own v3 API and LiteLLM's own spend log -- never against a fixed key |

The second check fires its own real requests and re-reads the real,
running system every time it runs. It never looks at anything in your
workspace except the three values you wrote.
