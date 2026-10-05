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

The questions are in the **Questions** tab, next to this brief. Answer them there; your answers are saved for you.
