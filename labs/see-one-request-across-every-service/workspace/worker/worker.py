#!/usr/bin/env python3
"""The worker -- a downstream "queue consumer" the gateway hands jobs to.

A real job pipeline: the gateway calls POST /process here (standing in for
a queue consumer picking up a job, in a scenario without a real message
broker), this service does its own local step, then forwards the job on to
storage for persistence with a second POST call. Three real, separate hops:
caller -> gateway -> (here) -> storage.

Your job: make this service's spans land in the SAME trace Jaeger already
shows for the gateway's own request, correctly nested under whatever called
each of them -- not a second, disconnected trace that happens to start here.
Every span below already carries real attributes and a real duration; only
where it's rooted is wrong.

Use the OTel SDK's own instrumentation and propagators (this file already
imports opentelemetry-instrumentation-flask and -requests below) -- nothing
here should ever read or write a `traceparent` header by hand.
"""
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
# TODO: this service never wires up FlaskInstrumentor. Every span it
# creates below is therefore a fresh root -- it never picks up whatever
# trace context the caller sent.
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
