#!/usr/bin/env python3
"""A 'regional proxy' stand-in: real Flask server (FlaskInstrumentor
extracts the inbound W3C traceparent litellm's own instrumented outbound
call sent) that forwards on to the real fake provider via real `requests`
(RequestsInstrumentor injects the traceparent onward) -- never a
hand-rolled header on either hop.

This is support-eu's second hop: LiteLLM's api_base for support-eu points
here, not at the real fake provider this file itself then calls on. A
request through support-eu is genuinely two real network hops past
LiteLLM, each with its own real span, each a real child of the one before
it -- not one hop pretending to be two.
"""
import os

from flask import Flask, request as flask_request, jsonify, Response
import requests
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

OTLP_ENDPOINT = os.environ["OTLP_HTTP_ENDPOINT"]
PORT = int(os.environ["PROXY_PORT"])
SERVICE_NAME = os.environ["SERVICE_NAME"]
REGION = os.environ["OPALIX_REGION"]
UPSTREAM_URL = os.environ["UPSTREAM_PROVIDER_URL"]

resource = Resource.create({"service.name": SERVICE_NAME})
provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTLP_ENDPOINT + "/v1/traces"), schedule_delay_millis=500)
)
trace.set_tracer_provider(provider)

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
RequestsInstrumentor().instrument()
tracer = provider.get_tracer("opalix.regional_proxy")


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/", defaults={"path": ""}, methods=["GET", "POST"])
@app.route("/<path:path>", methods=["GET", "POST"])
def relay(path):
    if path.rstrip("/") == "healthz":
        return "ok", 200
    with tracer.start_as_current_span("regional_proxy.relay") as span:
        span.set_attribute("opalix.span_kind", "regional_proxy_hop")
        span.set_attribute("opalix.region", REGION)
        # A real outbound HTTP call -- RequestsInstrumentor injects the real
        # W3C traceparent here, continuing whatever trace this request
        # itself arrived carrying, never re-derived or copied by hand.
        upstream = requests.post(
            UPSTREAM_URL.rstrip("/") + "/" + path,
            json=flask_request.get_json(silent=True) or {},
            timeout=15,
        )
        return Response(
            upstream.content, status=upstream.status_code, content_type=upstream.headers.get("content-type")
        )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
