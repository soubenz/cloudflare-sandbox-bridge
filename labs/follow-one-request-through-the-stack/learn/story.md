---
title: One slow request, no explanation
minutes: 2
---
It is Tuesday afternoon. Priya Nair from Support sends you a screenshot of an agent waiting on a reply, with the message "This one took ages. Why?" A minute later Jonas Berg from Finance adds a second question to the same thread: "And what did it cost? I need a number per request before I can split spend by team."

You cannot answer either yet. The request went through the gateway, out to a model, into a vector store and into a cache, and each of those is a separate service. Each logs on its own, in its own format, and none of the logs mention the others.

Maren Osei comes over. "This is why we run tracing. That request was instrumented end to end, and the trace is already in Jaeger. It is one request, four services, six spans. Nothing to send and nothing to fix. I want you to read it."

She sets three questions in front of you. Which span, other than the request itself, took the longest? How many tokens did the model calls in that trace use in total? And the cache lookup that shows up in the trace: what is it nested under?

"Do not tell me it looks like the model," she says. "I might agree, but Jonas cannot put a hunch in a report. Read the numbers off the trace and write them down."
