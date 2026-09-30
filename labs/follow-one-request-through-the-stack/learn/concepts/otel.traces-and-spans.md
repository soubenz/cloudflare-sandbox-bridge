---
id: otel.traces-and-spans
title: Traces and spans
minutes: 3
recap: A span is one timed unit of work with a name and attributes; a trace is every span that belongs to one request, sharing a trace id.
---
A **span** is one unit of work that someone chose to time: an HTTP handler, a database query, a model call. It records a name, a start time, a duration, a status and a set of **attributes** (Jaeger shows them as **Tags**). A **trace** is the set of spans that belong to one request. They share a trace id, which is what lets a tool stitch them into a single picture even when they came from different processes.

Each span also carries the name of the service that emitted it. That name comes from the resource the sender set up once, at start. In this lab a small script plays four services, `opalix-gateway`, `opalix-llm-worker`, `opalix-vector-store` and `opalix-cache`, and sends their spans over OTLP, the protocol real instrumented services use. Jaeger receives them and files them under one trace id.

Jaeger draws a trace as a **waterfall**. Each row is a span, its bar starts where the span started and its width is its duration, and the rows are indented by how they nest. Click a row to expand it and read its Tags.

Two things matter when you read durations:

- **A span's duration includes everything nested inside it.** The span for the whole request is always the widest, because it contains all the others. To find where time went, look below it.
- **A wide parent is not the same as a slow parent.** A parent's bar can be wide because a child is. Compare a span's own bar with the bars of its children to see whether the time is really its own.

You also do not have to eyeball widths. Each row shows its duration as a number, so you can compare exactly.

In the lab, open the jaeger tab, click Find Traces, and open the one trace. Expand each row, note the service and the duration, and keep the request span apart from the rest when you compare.
