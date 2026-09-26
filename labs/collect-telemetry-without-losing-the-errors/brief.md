# Collect telemetry without losing the errors

Opalix's gateway ships every request's trace through an OpenTelemetry
Collector pipeline (`otelcol-contrib`) before it lands in Jaeger. Nobody
can afford to store every single trace forever, so the pipeline samples
successful traffic down to something a backend can actually hold. That
part works. The problem is what it does to failures: right now, an error
trace gets exactly the same treatment as a successful one, which means
most of them vanish along with the traffic they were mixed in with.

## What you have

| Where | What |
|---|---|
| `otelcol-config.yaml` | The collector's whole pipeline: receives traces, samples them, batches them, ships whatever survives to Jaeger. This is what you edit. |
| **jaeger** tab | Jaeger's own UI. Search by service (`opalix-traffic`) to see whatever traces actually made it through. |
| `traffic` | Not yours to edit. A small service that sends a real mix of successful and error-status traces through the pipeline on request -- **run checks** drives it itself; you can also drive it by hand from your own terminal (`curl -X POST http://127.0.0.1:5010/run -d '{"n_success": 20, "n_error": 5}'`) to watch your changes take effect on real traffic. |

`otelcol-config.yaml` ships with a real, working sampling processor:
`probabilistic_sampler`, set to keep 10% of traffic. Ten percent of
*everything* is a perfectly reasonable-looking number if all you know is
"we get too much traffic to store." It just has no way to tell an error
trace from a successful one -- it decides purely from a trace's own ID,
before it has ever looked at what happened inside that trace.

## Your task

Make the pipeline keep **every** error trace, while still cutting
successful traffic down to a real fraction of itself -- not by turning the
sampling rate up until it stops mattering, and not by removing sampling
altogether.

Only `otelcol-config.yaml` needs to change. Nothing about Jaeger, the
`traffic` service, or the ports involved needs touching.

## Checking your work

**Run checks** never reads your config file. It drives `traffic` itself
with a real, exactly-known mix -- 200 successful traces and 30 error
traces, each individually tagged -- through whatever your pipeline
currently does, waits for it to settle, and then reads back what actually
survived from Jaeger itself, plus a real signal from the collector's own
telemetry for whether it's still batching before it exports.

| Check | Passes when |
|---|---|
| `no-error-trace-is-ever-lost` | All 30 of the 30 error traces sent this run are found in Jaeger afterward. Not most of them -- all of them. |
| `successful-traffic-is-meaningfully-reduced` | Successful-trace survival is meaningfully below 100% (not just "we kept everything, including the errors, so technically none of them were lost"). |
| `batching-still-happens` | The collector is still exporting in batches, not one span at a time. |

The second check exists to stop the first one being satisfied the easy
way -- turning sampling off entirely, or setting its rate to 100%, would
trivially keep every error trace too. You need all three passing at once.
