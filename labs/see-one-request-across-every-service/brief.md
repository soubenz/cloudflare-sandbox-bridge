# See one request across every service

One request now touches three of your services on its way through: a
**gateway** (the entry point callers hit), a **worker** (standing in for a
queue consumer that picks a job up and processes it), and **storage** (where
the worker's job ends up). Three real hops, three real processes.

Right now, if you fire a request through the gateway and go looking for it
in Jaeger, you won't find one trace that covers all three. You'll find the
gateway's own handful of spans -- and, somewhere else entirely, a second,
disconnected trace holding the worker's and storage's spans. Same request,
two stories.

## What you have

| Where | What |
|---|---|
| **jaeger** tab | Real Jaeger UI. No login. Search by service, or paste a trace id directly. |
| `services/gateway.py` | The entry point. `POST /ingest` starts the request, calls the worker, and returns the trace id it used -- in its own JSON response, so you always know exactly which trace to go look at. Already correctly instrumented; you don't need to touch it. |
| `worker/worker.py` | **This is what you fix.** `POST /process` does its own local work, then forwards the job to storage with a second call. Its spans have real durations and real attributes already -- they're just not part of the trace that got them there. |
| `services/storage.py` | Where the worker's job ends up. `POST /store` normally succeeds; a request body carrying `"trigger_error": true` makes it deliberately fail, with a real error status on its own span. Already correctly instrumented; you don't need to touch it. |

Everything here uses the real OpenTelemetry SDK's own auto-instrumentation
(`opentelemetry-instrumentation-flask`, `opentelemetry-instrumentation-requests`)
-- nothing in this lab reads or writes a `traceparent` header by hand, and
your fix shouldn't either.

## Your task

Make a request that goes through the gateway, into the worker, and on to
storage show up in Jaeger as **one connected trace**, with each hop's span
correctly nested under the span that actually called it -- not just
sharing a trace id by coincidence, and not a second trace that starts at
the worker.

Try it yourself first:

```bash
curl -X POST $GATEWAY_URL/ingest -H 'Content-Type: application/json' -d '{"job_id": "test-1"}'
```

The response carries a `trace_id`. Open the **jaeger** tab and look that
trace id up directly. What's in it? What isn't?

## Checking your work

**Run checks** never reads your code. It fires two real requests through the
running gateway -- one plain, one that deliberately makes storage fail --
and reads back whatever the running Jaeger actually recorded for each.

| Check | Passes when |
|---|---|
| `one-trace-not-many` | The one trace id the gateway's response carries contains spans from all three services -- opalix-gateway, opalix-worker, and opalix-storage -- not just the gateway's own. |
| `parent-child-chain-is-correct` | Every span in that trace is a real child of the span that actually called it, root to leaf -- not just present under the same trace id with its hierarchy broken. |
| `errors-still-propagate-through-the-chain` | A request built to make storage fail shows a real ERROR status on storage's own span, and the whole chain is still one connected, correctly-parented trace despite the failure. |
