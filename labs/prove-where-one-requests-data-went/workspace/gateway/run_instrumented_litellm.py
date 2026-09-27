#!/usr/bin/env python3
"""Runs LiteLLM's own FastAPI proxy app under real OTel SDK
auto-instrumentation: opentelemetry-instrumentation-fastapi (extracts an
inbound W3C traceparent and starts a real server span for every request --
the FastAPI equivalent of opentelemetry-instrumentation-flask, since
LiteLLM's proxy is a FastAPI app, not a Flask one) and
opentelemetry-instrumentation-httpx (injects the real W3C traceparent on
every outbound call LiteLLM's own OpenAI-compatible client makes -- the
httpx equivalent of opentelemetry-instrumentation-requests, since LiteLLM's
provider calls go through httpx/the openai SDK, not requests). Never a
hand-rolled traceparent header, on either side.

Two real, load-bearing facts, both verified live building this lab (see the
build report) before this file was written this way:

1. Importing litellm.proxy.proxy_server:app directly and serving it with
   our own uvicorn.run(), rather than the `litellm` CLI's own run_server()
   (equivalently, `opentelemetry-instrument litellm --config ...`, the
   standard zero-code wrapper): that wrapper re-execs into a fresh process
   with an OTel-inserted PYTHONPATH entry which breaks LiteLLM's own Prisma
   client import at startup (`ModuleNotFoundError: No module named
   'prisma'`) -- confirmed by running the exact same litellm command
   without the wrapper, which starts cleanly. Importing the app object and
   instrumenting it in-process sidesteps that PYTHONPATH rewrite entirely,
   using the exact same instrumentation libraries either way.

2. DISABLE_AIOHTTP_TRANSPORT=True is mandatory for the outbound half of
   this to actually carry a traceparent header. LiteLLM 1.102.1 defaults
   every one of its own outbound provider calls to a custom
   `LiteLLMAiohttpTransport` (an aiohttp-backed httpx.AsyncClient
   transport, on by default "for higher throughput"), which has its own
   `handle_async_request` implementation -- NOT httpx's own
   `AsyncHTTPTransport`, which is the class opentelemetry-instrumentation-
   httpx actually patches. Left on, a real span for the request still
   appears (created around litellm's own request handling), but the
   downstream call carries no traceparent at all and every downstream hop
   roots a disconnected trace of its own. Confirmed by capturing the
   literal headers a downstream stand-in received: no Traceparent header
   with the default transport, one present the moment this env var is set.
"""
import os

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

OTLP_ENDPOINT = os.environ["OTLP_HTTP_ENDPOINT"]
SERVICE_NAME = os.environ.get("OTEL_SERVICE_NAME", "opalix-litellm")
PORT = int(os.environ.get("LITELLM_PORT", "4000"))

resource = Resource.create({"service.name": SERVICE_NAME})
tracer_provider = TracerProvider(resource=resource)
tracer_provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTLP_ENDPOINT + "/v1/traces"), schedule_delay_millis=500)
)
trace.set_tracer_provider(tracer_provider)

# Real auto-instrumentation, set up before litellm's own app is imported:
#   - HTTPXClientInstrumentor: every outbound httpx call LiteLLM's own
#     OpenAI-compatible client makes (to a fake provider or a regional
#     proxy) is wrapped to inject the current span's W3C traceparent --
#     provided DISABLE_AIOHTTP_TRANSPORT=True is also set (see module
#     docstring, point 2), so that call actually goes through httpx's own
#     transport class rather than litellm's aiohttp-backed one.
#   - FastAPIInstrumentor (below, after import): every inbound HTTP request
#     to LiteLLM's own ASGI app has its W3C traceparent extracted and
#     becomes the active context for the request-handling coroutine, which
#     is exactly the context HTTPXClientInstrumentor reads when injecting.
HTTPXClientInstrumentor().instrument()

from litellm.proxy.proxy_server import app  # noqa: E402  (must follow instrumentation setup)

FastAPIInstrumentor().instrument_app(app)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
