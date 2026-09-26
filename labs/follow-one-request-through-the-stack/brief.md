# Follow one request through the stack

Nothing is broken here, and there is nothing to send. One real support
request has already happened, and it has already been traced. This is a
tour of that one trace: you read it in Jaeger and figure out where the
request's time went, where its tokens went, and how its pieces fit together.

## What is running

| Service | What it is doing |
|---|---|
| **jaeger** tab | A real Jaeger backend, holding one real trace: a support request that went through a gateway, called an LLM, queried a vector store, and wrote to a cache |

That one trace was sent at boot, over real OpenTelemetry OTLP, by a small
script pretending to be four separate services (`opalix-gateway`,
`opalix-llm-worker`, `opalix-vector-store`, `opalix-cache`) -- the same
protocol and the same client library a real instrumented service would use.
Nothing about reading it is scripted or simplified: the durations are real
elapsed time, and the span attributes are the same shape a real LLM call's
token usage would be recorded in.

## Open the trace

Open the **jaeger** tab. Click **Find Traces** in the left panel (the
`opalix-gateway` service should already be the only option; you don't need to
change anything else), then open the one trace that comes back.

You'll see a waterfall of six spans. Click on any row to expand it and see
its **Tags** -- its attributes. Look at:

- **How wide each bar is.** One span is dramatically wider than the rest --
  that's where almost all of the request's time actually went.
- **The tags on the LLM call** (`litellm.completion`). It carries its own
  token-usage attributes (`gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`) -- the same
  numbers a real gateway's spend log would be built from.
- **The indentation.** Every span nests under `handle_support_request`
  except one: look for the row that nests *under a child*, not directly
  under the top-level request. That's a span calling another span, not just
  the gateway doing four things in a row.

## Answer these

1. Which single span -- by its name, not the top-level `handle_support_request`
   request itself -- took the longest to run?
2. Add up `gen_ai.usage.total_tokens` across every span tagged as an LLM call
   in this trace (there's only one, but add it up properly rather than
   assuming that in general). What's the total?
3. Find the span named `cache.get`. Which span is its *direct* parent --
   the row it's actually nested directly under, not the top-level request?

Write your answers into `/workspace/answers.json`, which starts out as:

```json
{
  "longest_span_name": null,
  "llm_total_tokens": null,
  "cache_get_parent_span": null
}
```

Replace each `null`: the first and third with a span name (a string, exactly
as it appears in the trace), the second with a number.

## Checking your work

| Check | Passes when |
|---|---|
| `jaeger-is-up` | Jaeger is up and its own query API reports the seeded trace, all six spans present |
| `answers-match-the-trace` | Your three answers match what that same trace actually shows, checked live against Jaeger's own API, not against a fixed key |

The second check re-reads the live trace itself every time it runs -- it
never looks at your answers.json for anything except the three values you
wrote, and it never depends on you having clicked anything in particular in
the UI first.
