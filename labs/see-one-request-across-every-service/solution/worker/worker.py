#!/usr/bin/env python3
"""Reference solution: the only change from the skeleton is wiring up
FlaskInstrumentor on the server side, so this service's inbound WSGI
middleware extracts the real W3C traceparent header the gateway's
(already-instrumented) outbound `requests` call sent, and every span
started below nests under that extracted context instead of rooting a new
trace. The outbound call to storage was already correctly instrumented in
the skeleton (RequestsInstrumentor) -- it just had nothing real to inject
until the inbound side was fixed."""
import os
import time

from flask import Flask, request as flask_request, jsonify
import requests
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

OTLP_ENDPOINT = os.environ["OTLP_HTTP_ENDPOINT"]
STORAGE_URL = os.environ["STORAGE_URL"]
PORT = int(os.environ.get("WORKER_PORT", "5002"))

resource = Resource.create({"service.name": "opalix-worker"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTLP_ENDPOINT + "/v1/traces"), schedule_delay_millis=500)
)
trace.set_tracer_provider(provider)

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
RequestsInstrumentor().instrument()
tracer = provider.get_tracer("opalix.worker")


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/process", methods=["POST"])
def process():
    body = flask_request.get_json(silent=True) or {}
    with tracer.start_as_current_span("worker.process_job") as span:
        span.set_attribute("job.id", body.get("job_id", "unknown"))
        time.sleep(0.02)
        resp = requests.post(STORAGE_URL + "/store", json=body, timeout=10)
        span.set_attribute("storage.status_code", resp.status_code)
        if resp.status_code >= 500:
            span.set_status(trace.Status(trace.StatusCode.ERROR, "storage call failed"))

    return jsonify({"status": "processed", "storage_status": resp.status_code}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
