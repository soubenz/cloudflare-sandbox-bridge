#!/usr/bin/env python3
"""A scripted stand-in for a regional model provider, speaking the OpenAI
chat-completions shape well enough for LiteLLM to proxy to it. There is no
real model here and no route out of the container to one.

Real Flask + real opentelemetry-instrumentation-flask: this process
extracts whatever W3C traceparent header the caller sent (LiteLLM's own
instrumented outbound call, or a regional proxy's own outbound `requests`
call) and records its own span as a genuine child of it -- never a
hand-rolled header, and never assumed to be the trace's root just because
this file doesn't know who called it.

Tags every span with opalix.region so a trace-reading check (or a learner)
can tell which region a request's data actually reached, and with a fresh
opalix.response_id every single call -- the one thread that ties this
span, this response's own `id` field, and the request_id LiteLLM's own
spend log records for the same call all together.
"""
import os
import time
import uuid

from flask import Flask, request as flask_request, jsonify
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor

OTLP_ENDPOINT = os.environ["OTLP_HTTP_ENDPOINT"]
PORT = int(os.environ["PROVIDER_PORT"])
SERVICE_NAME = os.environ["SERVICE_NAME"]
REGION = os.environ["OPALIX_REGION"]
DEFAULT_COMPLETION_TOKENS = 32

resource = Resource.create({"service.name": SERVICE_NAME})
# provider.get_tracer(...), never trace.get_tracer(...) before
# set_tracer_provider -- the real trap every sibling Module 4 lab's own
# services avoid (see labs/follow-one-request-through-the-stack/workspace/
# services/seed_trace.py's header comment): a bare trace.get_tracer() call
# would silently return a no-op tracer here, with zero spans exported and
# zero exceptions raised anywhere.
provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTLP_ENDPOINT + "/v1/traces"), schedule_delay_millis=500)
)
trace.set_tracer_provider(provider)

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
tracer = provider.get_tracer("opalix.fake_provider")


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/", defaults={"path": ""}, methods=["GET", "POST"])
@app.route("/<path:path>", methods=["GET", "POST"])
def catch_all(path):
    if path.rstrip("/") == "healthz":
        return "ok", 200
    payload = flask_request.get_json(silent=True) or {}
    with tracer.start_as_current_span("provider.chat_completion") as span:
        span.set_attribute("opalix.span_kind", "provider_call")
        span.set_attribute("opalix.region", REGION)
        span.set_attribute("gen_ai.system", "opalix-fake-provider")
        response_id = "chatcmpl-fake-%s-%s" % (REGION, uuid.uuid4().hex[:12])
        span.set_attribute("opalix.response_id", response_id)
        messages = payload.get("messages") or []
        last_content = str(messages[-1].get("content", "")) if messages else ""
        span.set_attribute("opalix.last_message", last_content[:200])
        prompt_tokens = len(last_content.split())
        completion_tokens = int(payload.get("max_tokens") or DEFAULT_COMPLETION_TOKENS)
        total_tokens = prompt_tokens + completion_tokens
        span.set_attribute("gen_ai.usage.input_tokens", prompt_tokens)
        span.set_attribute("gen_ai.usage.output_tokens", completion_tokens)
        span.set_attribute("gen_ai.usage.total_tokens", total_tokens)
        time.sleep(0.02)
        return jsonify(
            {
                "id": response_id,
                "object": "chat.completion",
                "model": payload.get("model", "fake-model"),
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "fixed-fake-reply from %s" % REGION},
                    }
                ],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": total_tokens,
                },
            }
        ), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
