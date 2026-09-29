#!/usr/bin/env python3
"""A scripted stand-in for a regional model provider, reused wholesale from
labs/prove-where-one-requests-data-went/workspace/services/fake_provider.py
(same Flask + real OTel SDK auto-instrumentation, same opalix.region /
opalix.response_id span tagging -- see that file's own header comment for
why `provider.get_tracer(...)`, never a bare `trace.get_tracer(...)` before
`set_tracer_provider`, matters here).

Two things added for this lab, on top of that file:

  1. On-demand fault injection (POST /admin/mode {"mode": "healthy"|"down"}),
     the same shape as labs/keep-answering-when-a-provider-fails's own
     fault_proxy.py admin endpoint -- reused here directly on the provider
     itself rather than through a separate proxy in front of it, since this
     lab only ever needs to fail ONE specific provider (eu) on demand, and
     every provider already runs this same file. In `down` mode every call
     is refused with a real 503 *and a real span is still recorded*
     (`opalix.span_kind=refused_call`) -- an auditor reading the trace
     should be able to see that region was asked and said no, not find
     silence where a call should have been.

  2. A provider-local request log (GET /log), independent of both LiteLLM's
     own view and Jaeger's -- a third, live-checkable source of truth for
     "did this region actually get bothered", the same role
     fault_proxy.py's own /log plays in that sibling lab. This is what
     checks/_harness.py polls to prove provider-us and provider-apac saw
     *zero* requests while provider-eu was down and the EU-only alias was
     being hammered -- a check against the leaking provider's own record,
     never against LiteLLM's config or logs alone.

The mode is switched with the admin endpoint, not by editing this file --
editing it does not change the running service; restart it from the
Services panel instead.
"""
import os
import threading
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
MODES = ("healthy", "down")

resource = Resource.create({"service.name": SERVICE_NAME})
# provider.get_tracer(...), never trace.get_tracer(...) before
# set_tracer_provider -- see this file's upstream original in
# prove-where-one-requests-data-went for why a bare trace.get_tracer() call
# would silently return a no-op tracer here.
provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTLP_ENDPOINT + "/v1/traces"), schedule_delay_millis=500)
)
trace.set_tracer_provider(provider)

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
tracer = provider.get_tracer("opalix.fake_provider")

_lock = threading.Lock()
_state = {"mode": "healthy", "requests": []}


def _record(entry):
    with _lock:
        entry = dict(entry, seq=len(_state["requests"]) + 1, ts=time.time())
        _state["requests"].append(entry)


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/admin/mode", methods=["POST"])
def set_mode():
    payload = flask_request.get_json(silent=True) or {}
    mode = payload.get("mode")
    if mode not in MODES:
        return jsonify({"error": "mode must be one of %s" % (MODES,)}), 400
    with _lock:
        _state["mode"] = mode
    print("provider-%s: mode -> %s" % (REGION, mode), flush=True)
    return jsonify({"ok": True, "mode": mode})


@app.route("/admin/reset", methods=["POST"])
def reset_log():
    with _lock:
        _state["requests"] = []
    return jsonify({"ok": True})


@app.route("/log")
def get_log():
    with _lock:
        return jsonify({"region": REGION, "mode": _state["mode"], "requests": list(_state["requests"])})


@app.route("/", defaults={"path": ""}, methods=["GET", "POST"])
@app.route("/<path:path>", methods=["GET", "POST"])
def catch_all(path):
    if path.rstrip("/") in ("healthz", "admin/mode", "admin/reset", "log"):
        # Already routed above via their own rules; a request only lands
        # here for those names if it used the "wrong" HTTP method.
        return jsonify({"error": "method not allowed for %s" % path}), 405

    with _lock:
        mode = _state["mode"]

    payload = flask_request.get_json(silent=True) or {}

    if mode == "down":
        # A real span for the refusal itself -- an auditor reading this
        # trace should see that this region was actually asked and said
        # no, never silence where a call should have been.
        with tracer.start_as_current_span("provider.refused_call") as span:
            span.set_attribute("opalix.span_kind", "refused_call")
            span.set_attribute("opalix.region", REGION)
            span.set_attribute("opalix.result", "refused_outage")
        _record({"result": "refused_outage"})
        return jsonify({"error": {"message": "%s is unavailable (fault: mode=down)" % REGION,
                                   "type": "server_error"}}), 503

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
        _record({"result": "served", "response_id": response_id})
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
    print("fake provider (%s) listening on :%d" % (REGION, PORT), flush=True)
    app.run(host="0.0.0.0", port=PORT)
