---
title: Hops and audit trails
id: sovereignty.hops-audit
minutes: 4
order: 3
recap: A trace lists every service a request touched; the gateway's own log records only the first destination, so only the trace shows a multi-hop route.
---
You have met the hop: a service that handles a request on its way to the model. The route for one alias in this lab has a service in the middle, and that changes what you can prove.

::diagram[sovereignty-hops-audit]

There are two independent records of every call.

**LiteLLM's spend log** is the gateway's own bookkeeping. Each call becomes a row in the Postgres table `LiteLLM_SpendLogs`, with a `request_id`, the `model_group` (the alias) and the `api_base`. The `api_base` is where the gateway sent the request, which is the first hop. If that address is a proxy, the log says so and stops. It cannot know what the proxy did next.

**A trace** is a set of spans that share one trace id. Each service writes its own spans and exports them to Jaeger. For the spans to join one tree, every hop has to pass the trace context along on its outgoing call, using the W3C `traceparent` header. A hop that forgets starts a separate trace, and the journey looks shorter than it was. This is why an audit trail is only as strong as its least instrumented service: a missing span is not evidence that the hop did not happen.

To count hops from a trace, count distinct `service.name` values, not spans. One service can emit several spans, and it is still one service. Decide in advance whether you count the gateway, and say so in your answer, because "services in the trace" and "hops past the gateway" differ by one.

How to tie the two records to one request: every response has an `id`. The final provider span carries it as `opalix.response_id`, and the spend log stores it as `request_id`. Search the trace by that id, and query the spend log by the same id, and you know both describe the same call.

Try it in the lab. Send a request through each alias and note the response id. Open the trace in Jaeger and expand every row. Then run the `psql` query for the same id from the brief and compare what the log knows to what the trace shows. Which one tells you more about where the request went?
