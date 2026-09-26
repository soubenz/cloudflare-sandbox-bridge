#!/usr/bin/env python3
"""The gateway -- untouchable entry point. Real OTel SDK auto-instrumentation
(opentelemetry-instrumentation-flask + -requests), no hand-rolled headers.
RequestsInstrumentor injects the real W3C traceparent on the outbound call
to the worker automatically, from the OTel SDK's own context propagators."""
import os
import time

from flask import Flask, jsonify
import requests
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

OTLP_ENDPOINT = os.environ["OTLP_HTTP_ENDPOINT"]  # e.g. http://127.0.0.1:4318
WORKER_URL = os.environ["WORKER_URL"]
PORT = int(os.environ.get("GATEWAY_PORT", "5001"))

resource = Resource.create({"service.name": "opalix-gateway"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTLP_ENDPOINT + "/v1/traces"), schedule_delay_millis=500)
)
# provider.get_tracer(...), never trace.get_tracer(...) before
# set_tracer_provider -- the m4-common.md trap (a bare trace.get_tracer call
# silently returns a no-op tracer if set_tracer_provider was never called).
trace.set_tracer_provider(provider)

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
RequestsInstrumentor().instrument()
tracer = provider.get_tracer("opalix.gateway")


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/ingest", methods=["POST"])
def ingest():
    from flask import request as flask_request

    body = flask_request.get_json(silent=True) or {}
    with tracer.start_as_current_span("handle_ingest_request") as span:
        span.set_attribute("job.id", body.get("job_id", "unknown"))
        time.sleep(0.01)
        # A plain, auto-instrumented outbound call -- RequestsInstrumentor
        # injects the real traceparent header here. Nothing in this file
        # ever reads or writes a `traceparent` header by hand.
        resp = requests.post(WORKER_URL + "/process", json=body, timeout=10)
        span.set_attribute("worker.status_code", resp.status_code)
        trace_id_hex = format(span.get_span_context().trace_id, "032x")

    return jsonify(
        {
            "status": "accepted",
            "trace_id": trace_id_hex,
            "worker_status": resp.status_code,
            "worker_body": resp.json() if resp.headers.get("content-type", "").startswith("application/json") else None,
        }
    ), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
