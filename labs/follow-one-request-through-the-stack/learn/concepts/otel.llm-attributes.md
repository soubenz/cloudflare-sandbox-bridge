---
id: otel.llm-attributes
title: Token and cost attributes on model calls
minutes: 3
recap: A model call span carries gen_ai.* attributes for model and token counts; cost is derived from tokens and a price, and totals come from summing across spans.
---
A trace tells you where time went. To learn what a model call cost, the model-call span has to carry the numbers. OpenTelemetry has agreed names for that, the **gen_ai semantic conventions**, so any backend can read them:

::diagram[otel-llm-attributes]

- `gen_ai.request.model` is the model the caller asked for, and `gen_ai.response.model` is the one that answered. The two can differ when a provider resolves a name to a dated version.
- `gen_ai.usage.input_tokens` counts the prompt and `gen_ai.usage.output_tokens` counts the reply.
- The conventions define input and output counts. Some emitters, including the seed script in this lab, also record `gen_ai.usage.total_tokens`, which is their sum. A total is convenient, but it is derived.

**Cost is not an attribute here.** It is tokens multiplied by a per-model price, usually with different prices for input and output. A gateway's spend log and a dashboard both compute it from these same counts. So the token attributes are the raw material for the number Finance wants, and the model attributes tell you which price applies.

Two habits matter when you total tokens for a request:

- **Sum over the spans that are model calls.** One request can make several calls: a retry, a tool loop, a second model for a check. Each call is its own span with its own counts. Picking one span by name and assuming it is the only one undercounts as soon as the request grows.
- **Identify model calls by what they carry, not by a name you guessed.** Spans in this trace also carry an `opalix.span_kind` attribute, and one of its values marks a span as a model call. Filtering on the attribute is safer than matching a span name.

To split spend by team, the trace also needs an attribute saying who made the request. In this trace, the request span at the top carries one such identifier, and the model-call span carries the token counts. Joining them is what gives you cost per requester.

In the lab, expand the model call's row in Jaeger, open its Tags, and read the usage attributes there.
