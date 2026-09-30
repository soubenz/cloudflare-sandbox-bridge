# Follow one request through the stack

Nothing is broken here, and there is nothing to send. One real support request
has already happened and has already been traced. You read that trace in Jaeger
and work out where its time and its tokens went.

## What is running

| Service | What it is doing |
|---|---|
| **jaeger** tab | A real Jaeger backend holding one trace: a support request that went through a gateway, called an LLM, queried a vector store and wrote to a cache |

A small script sent that trace at boot over OTLP, playing four services
(`opalix-gateway`, `opalix-llm-worker`, `opalix-vector-store`, `opalix-cache`).
The durations are real elapsed time.

## Open the trace

In the **jaeger** tab, click **Find Traces**, then open the one trace that
comes back. It has six spans. Click a row to see its **Tags**. The LLM call
(`litellm.completion`) carries `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens` and `gen_ai.usage.total_tokens`.

## Answer these

1. Which single span, other than the top-level `handle_support_request`, took
   the longest to run?
2. Add up `gen_ai.usage.total_tokens` across every span tagged as an LLM call
   in this trace. What is the total?
3. Find the span named `cache.get`. Which span is its *direct* parent?

Write your answers into `/workspace/answers.json`, which starts out as:

```json
{
  "longest_span_name": null,
  "llm_total_tokens": null,
  "cache_get_parent_span": null
}
```

Replace each `null`: the first and third with a span name (a string, exactly as
it appears in the trace), the second with a number.

Done means `answers-match-the-trace` agrees with what Jaeger's API reports for
the trace right now.
