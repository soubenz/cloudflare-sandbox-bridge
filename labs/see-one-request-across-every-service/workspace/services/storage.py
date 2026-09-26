#!/usr/bin/env python3
"""The second downstream hop -- untouchable. Represents wherever a queue
worker's job ends up (a vector store / embeddings index in this scenario).
Real OTel SDK auto-instrumentation (Flask server side). If the worker
propagates context correctly, this service's inbound server span is a real
child of whatever span called it -- this file never has to know or care
which service that was.

Deliberately fails (real ERROR span status, real exception event) when the
incoming job body carries `"trigger_error": true` -- this is the lab's
planted downstream failure for the errors-still-propagate check."""
import os
import time

from flask import Flask, request as flask_request, jsonify
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.trace import Status, StatusCode

OTLP_ENDPOINT = os.environ["OTLP_HTTP_ENDPOINT"]
PORT = int(os.environ.get("STORAGE_PORT", "5003"))

resource = Resource.create({"service.name": "opalix-storage"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTLP_ENDPOINT + "/v1/traces"), schedule_delay_millis=500)
)
trace.set_tracer_provider(provider)

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
tracer = provider.get_tracer("opalix.storage")


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/store", methods=["POST"])
def store():
    body = flask_request.get_json(silent=True) or {}
    with tracer.start_as_current_span("storage.upsert_embedding") as span:
        span.set_attribute("db.system", "vector_store")
        span.set_attribute("job.id", body.get("job_id", "unknown"))
        time.sleep(0.01)
        if body.get("trigger_error"):
            exc = RuntimeError("vector index locked")
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, "vector index locked"))
            return jsonify({"status": "error", "detail": "vector index locked"}), 500
    return jsonify({"status": "stored"}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
