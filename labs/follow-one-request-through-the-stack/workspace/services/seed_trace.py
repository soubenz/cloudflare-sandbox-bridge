#!/usr/bin/env python3
"""Boot-time seed: sends ONE realistic multi-service trace into Jaeger.

Runs once, backgrounded inside jaeger's own service argv (same shape as
seed_documents.py in Module 3's see-why-a-document-matched -- it polls the
thing it depends on itself, so nothing in the manifest has to wait for it,
and jaeger's own healthcheck is what the platform actually watches).

Real opentelemetry-sdk + OTLPSpanExporter, sent over real OTLP/HTTP to
jaeger's own otlp receiver -- never Jaeger's API directly, and never a
hand-rolled span/trace-id format, so the trace a learner opens in the
Jaeger UI looks exactly like one a real instrumented service would have
produced. Four separate TracerProviders (one per resource/service.name)
model four separate real services -- 'gateway', 'llm-worker',
'vector-store', 'cache' -- all reporting into the SAME trace by threading
one shared span context through each start_span() call, the same way a
real W3C traceparent header would carry a trace across a process boundary
(the mechanism itself was proven for a real HTTP hop in
$SCRATCH/otel-inv/FINDINGS.md S3; this script reproduces the same
context-propagation API in a single process rather than across a real
network, since this is a pre-seeded Explore lab, not the Build lab that
proves the real hop).

Real trap, load-bearing (FINDINGS.md #6): call provider.get_tracer(...),
NEVER trace.get_tracer(...) -- the latter silently returns a no-op tracer
if set_tracer_provider() was never called on it, with zero exception and
zero spans exported. Every get_tracer() call below is on a provider
instance for exactly this reason.

Idempotency note: unlike a Postgres-backed seed script, this one is NOT
idempotent against repeats -- Jaeger's storage here is in-memory
(config.yaml: memory backend), so a restart of the jaeger service wipes it
and this script (re-run as part of the same service argv) sends a fresh
copy of the exact same trace. That is the desired behavior: there is
always exactly one seeded trace live, never zero, never two.
"""
import os
import time
import urllib.request

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.trace import SpanKind, Status, StatusCode, set_span_in_context

OTLP_HTTP_ENDPOINT = os.environ.get("OTLP_HTTP_ENDPOINT", "http://127.0.0.1:4318/v1/traces")
JAEGER_QUERY_URL = os.environ.get("JAEGER_QUERY_URL", "http://127.0.0.1:16686")


def wait_for_jaeger(timeout_s=60):
    """Jaeger's own healthcheck (manifest-level, http GET /) is what the
    platform watches; this is this script's own readiness poll so it never
    races the otlp receiver coming up inside the same process."""
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(JAEGER_QUERY_URL + "/", timeout=3) as resp:
                if resp.status == 200:
                    return
        except Exception as e:  # noqa: BLE001 -- genuinely any failure just means "not ready yet"
            last_err = e
        time.sleep(1)
    raise RuntimeError("jaeger did not become ready within %ss (last error: %s)" % (timeout_s, last_err))


def make_provider(service_name):
    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    # SimpleSpanProcessor, not Batch: this script sends exactly six spans
    # once and exits: each span is exported synchronously as soon as it
    # ends, so provider.shutdown() below is guaranteed to have nothing left
    # buffered.
    provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=OTLP_HTTP_ENDPOINT)))
    return provider


def main():
    wait_for_jaeger()

    gateway_provider = make_provider("opalix-gateway")
    llm_provider = make_provider("opalix-llm-worker")
    vector_provider = make_provider("opalix-vector-store")
    cache_provider = make_provider("opalix-cache")

    gateway_tracer = gateway_provider.get_tracer("opalix.gateway")
    llm_tracer = llm_provider.get_tracer("opalix.llm_worker")
    vector_tracer = vector_provider.get_tracer("opalix.vector_store")
    cache_tracer = cache_provider.get_tracer("opalix.cache")

    # A support agent's request comes in: the gateway verifies the caller,
    # asks the LLM for an answer, pulls supporting KB citations from the
    # vector store (which itself checks an embedding cache first), then
    # writes the finished response into the response cache.
    root = gateway_tracer.start_span(
        "handle_support_request",
        kind=SpanKind.SERVER,
        attributes={
            "opalix.span_kind": "gateway",
            "http.method": "POST",
            "http.route": "/v1/support/respond",
            "opalix.customer_id": "cust_48213",
        },
    )
    root_ctx = set_span_in_context(root)

    auth_span = gateway_tracer.start_span(
        "auth.verify_session",
        context=root_ctx,
        kind=SpanKind.INTERNAL,
        attributes={"opalix.span_kind": "auth_check", "auth.method": "session_token"},
    )
    time.sleep(0.012)
    auth_span.set_status(Status(StatusCode.OK))
    auth_span.end()

    # The slow one, on purpose -- roughly 100x auth, 10x the vector query.
    # Real token-usage attributes live here, gen_ai semantic-convention
    # names (https://opentelemetry.io/docs/specs/semconv/gen-ai/).
    llm_span = llm_tracer.start_span(
        "litellm.completion",
        context=root_ctx,
        kind=SpanKind.CLIENT,
        attributes={
            "opalix.span_kind": "llm_call",
            "gen_ai.system": "litellm",
            "gen_ai.request.model": "gpt-4o-mini",
            "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
        },
    )
    time.sleep(1.1)
    llm_span.set_attribute("gen_ai.usage.input_tokens", 612)
    llm_span.set_attribute("gen_ai.usage.output_tokens", 143)
    llm_span.set_attribute("gen_ai.usage.total_tokens", 755)
    llm_span.set_status(Status(StatusCode.OK))
    llm_span.end()

    vector_span = vector_tracer.start_span(
        "vector_db.query",
        context=root_ctx,
        kind=SpanKind.CLIENT,
        attributes={
            "opalix.span_kind": "vector_query",
            "db.system": "vectordb",
            "db.operation": "query",
            "opalix.results_returned": 4,
        },
    )
    time.sleep(0.03)
    # Genuinely nested: the vector store's own embedding-cache check is a
    # real child of vector_db.query, not a sibling of it -- this is the
    # trace's one non-trivial hierarchy question (its direct parent is
    # vector_db.query, not the top-level request span).
    vector_ctx = set_span_in_context(vector_span)
    cache_get_span = cache_tracer.start_span(
        "cache.get",
        context=vector_ctx,
        kind=SpanKind.INTERNAL,
        attributes={
            "opalix.span_kind": "embedding_cache_check",
            "cache.key": "embed:q_c9f21a",
            "cache.hit": False,
        },
    )
    time.sleep(0.02)
    cache_get_span.set_status(Status(StatusCode.OK))
    cache_get_span.end()
    time.sleep(0.045)
    vector_span.set_status(Status(StatusCode.OK))
    vector_span.end()

    cache_set_span = cache_tracer.start_span(
        "cache.set",
        context=root_ctx,
        kind=SpanKind.CLIENT,
        attributes={
            "opalix.span_kind": "cache_write",
            "cache.key": "support:cust_48213:q_c9f21a",
            "cache.hit": False,
        },
    )
    time.sleep(0.006)
    cache_set_span.set_status(Status(StatusCode.OK))
    cache_set_span.end()

    root.set_status(Status(StatusCode.OK))
    root.end()

    trace_id = "%032x" % root.get_span_context().trace_id

    for provider in (gateway_provider, llm_provider, vector_provider, cache_provider):
        provider.shutdown()

    print("seeded 1 trace, 6 spans across 4 services, trace_id=%s" % trace_id, flush=True)


if __name__ == "__main__":
    main()
