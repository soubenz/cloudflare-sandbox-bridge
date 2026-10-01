---
id: otel.what-is-tracing
title: What a trace is and why one request needs one
minutes: 3
order: 1
recap: A trace is the record of one request across every service it touched, built from spans (timed steps) that share a trace id, so you read it as one timeline.
---
Maren said the request was "traced end to end." Here is what that means and why Priya's question cannot be answered without it.

**The problem.** The slow request passed through four services: the gateway, a worker that calls the model, a vector store that looks up documents, and a cache. Each one writes its own log, in its own format, on its own clock. One log says "request received", another says "query done", and nothing says they belong to the same request. With four logs you have a guess, not an answer.

**What a trace is.** A **trace** is the record of one request from start to finish, across every service that handled it. Think of a parcel tracking page: one parcel, every stop and when it happened, instead of four depot logs.

**How one is built**

1. The first service to see the request makes a **trace id**, a label that belongs to this request only.
2. It sends that id along with every call it makes, and each service passes it on again.
3. Each service times its own pieces of work. One timed piece is a **span**: a name, a start, an end, and **attributes**, which are labels such as the model name or a token count.
4. A span names its **parent**, the span that was running when it began. The first span has no parent. Linked together, the spans form a tree.
5. Each service sends its finished spans to a tracing backend, which groups them by trace id.

::diagram[otel-what-is-tracing]

**What you see.** The backend draws one trace as a timeline. Each row is a span, indented under its parent, with a bar that starts when the span started and is as wide as it ran. The widest bars show where the time went. Click a row and its attributes open beside it.

**Words this lab uses**

- **Service**: one program that handles part of a request. Every span records which one made it.
- **Trace**: all the spans that share one trace id.
- **Span**: one timed step, such as a model call or a cache read.
- **Parent**: the span a span was started from.
- **Attribute**: a label on a span. Jaeger, the tracing backend here, calls them Tags.

**In the lab.** Nothing to send. One real trace is already in Jaeger, with six spans from four services. You will open it and read three facts off it: which span took the longest, how many tokens the model calls used, and which span the cache lookup sits under. The next lessons cover how to read each.
