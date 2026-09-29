#!/usr/bin/env python3
"""Starter "AI feature" service.

This is the paved road: copy this directory as the starting point for any
new feature that needs a model response from the shared gateway. It is
supposed to already do the right thing by default, so a new feature team
never has to rediscover any of this on their own:

  - a bounded timeout and a bounded number of retries on the outbound call
    to the gateway, so one slow or hung provider can never block this
    service forever;
  - a credential loaded from credentials.json -- a real virtual key the
    platform minted for this service specifically, restricted to the one
    model alias it needs, never the gateway's master key;
  - real tracing, wired to the same OTel Collector / Jaeger stack every
    other service on this platform reports to, so every call this service
    makes is visible in the jaeger tab without the owning team adding
    anything.

Add your own feature logic under /answer.
"""
import json
import os
import time

from flask import Flask, jsonify, request as flask_request
import requests
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

OTLP_ENDPOINT = os.environ["OTLP_HTTP_ENDPOINT"]  # e.g. http://127.0.0.1:4318
LITELLM_URL = os.environ["LITELLM_URL"].rstrip("/")
MODEL_NAME = os.environ.get("MODEL_NAME", "feature-model")
CREDENTIALS_FILE = os.environ.get("CREDENTIALS_FILE", "/workspace/template/credentials.json")
PORT = int(os.environ.get("TEMPLATE_PORT", "8980"))

# --- tracing: real SDK, real exporter, wired to the shared collector -----
resource = Resource.create({"service.name": "opalix-template"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTLP_ENDPOINT + "/v1/traces"), schedule_delay_millis=500)
)
# The fix: register this provider globally. Without this line, every
# tracer this file (and every auto-instrumentation library it wires up)
# obtains -- including via trace.get_tracer() below -- resolves against
# the SDK's own default no-op provider instead, and every span "created"
# is silently thrown away rather than exported. Nothing about that failure
# is loud: no exception, no log line, just zero spans in Jaeger.
trace.set_tracer_provider(provider)

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
RequestsInstrumentor().instrument()
tracer = provider.get_tracer("opalix.template")

# --- the scoped credential the platform minted for this service ---------
def _load_credentials():
    for _ in range(60):
        try:
            with open(CREDENTIALS_FILE) as f:
                return json.load(f)
        except (OSError, ValueError):
            time.sleep(0.5)
    raise RuntimeError("credentials file %s never appeared" % CREDENTIALS_FILE)


_creds = _load_credentials()
API_KEY = _creds["api_key"]

# --- the outbound call: a bounded timeout and a bounded retry -----------
# A connection failure is worth one quick retry -- the gateway process
# itself may just be mid-restart. A *read* timeout means the deployment on
# the other end is hung; retrying that would only spend the same bounded
# wait a second time; the honest answer is to give up and tell the caller.
CONNECT_TIMEOUT_S = 3
READ_TIMEOUT_S = 6
MAX_CONNECT_ATTEMPTS = 2


def _call_gateway(question):
    last_exc = None
    for attempt in range(1, MAX_CONNECT_ATTEMPTS + 1):
        try:
            return requests.post(
                LITELLM_URL + "/chat/completions",
                json={"model": MODEL_NAME, "messages": [{"role": "user", "content": question}]},
                headers={"Authorization": "Bearer %s" % API_KEY},
                timeout=(CONNECT_TIMEOUT_S, READ_TIMEOUT_S),
            )
        except requests.exceptions.ConnectionError as e:
            last_exc = e
            time.sleep(0.3 * attempt)
            continue
        # requests.exceptions.Timeout (a hung deployment) is not retried --
        # it propagates straight out of this function.
    raise last_exc


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/answer", methods=["POST"])
def answer():
    body = flask_request.get_json(silent=True) or {}
    question = body.get("question", "")
    with tracer.start_as_current_span("template.answer") as span:
        span.set_attribute("question.length", len(question))
        trace_id_hex = format(span.get_span_context().trace_id, "032x")
        try:
            resp = _call_gateway(question)
        except requests.exceptions.RequestException as e:
            span.record_exception(e)
            span.set_status(trace.Status(trace.StatusCode.ERROR, str(e)))
            return jsonify({"error": "upstream call failed: %s" % e, "trace_id": trace_id_hex}), 502

        span.set_attribute("gateway.status_code", resp.status_code)
        if resp.status_code != 200:
            span.set_status(trace.Status(trace.StatusCode.ERROR, "gateway returned %s" % resp.status_code))
            return jsonify({"error": "gateway returned %s" % resp.status_code, "trace_id": trace_id_hex}), 502

        data = resp.json()
        text = data["choices"][0]["message"]["content"]

    return jsonify({"answer": text, "trace_id": trace_id_hex}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
