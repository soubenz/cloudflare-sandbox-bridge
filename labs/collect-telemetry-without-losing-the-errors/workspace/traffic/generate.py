#!/usr/bin/env python3
"""The traffic generator. Not part of the lesson -- **run checks** drives
it directly (POST /run) to send a known, exactly-tagged mix of successful
and error traces through whatever otelcol-config.yaml currently does, then
counts real survivors back out of Jaeger. You don't need to edit this file
to pass the lab; it's here so you can see exactly what's being sent if you
want to (`curl -X POST http://127.0.0.1:5010/run -d '{"n_success": 20,
"n_error": 5}'` works from your own terminal too, and is a good way to
watch otelcol-config.yaml's effect on real traffic while you iterate).

Each simulated request is one real, separate root span -- a genuinely
distinct OTLP export per "request", the same shape a real caller's
individual HTTP requests would arrive in -- tagged with a unique
`case.id` span attribute so a grader (or you) can match survivors back to
exactly what was sent. `outcome=error` traces get a real ERROR span status
with a recorded exception; everything else gets OK. This mirrors the
Module 4 feasibility investigation's own send_sampling_mix.py technique.
"""
import json
import os
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.trace import Status, StatusCode

OTLP_ENDPOINT = os.environ.get("TRAFFIC_OTLP_ENDPOINT", "http://127.0.0.1:4318/v1/traces")
PORT = int(os.environ.get("TRAFFIC_PORT", "5010"))
SERVICE_NAME = os.environ.get("TRAFFIC_SERVICE_NAME", "opalix-traffic")

_lock = threading.Lock()  # one /run at a time -- keeps case.id sequencing simple


def _send_mix(run_id, n_success, n_error):
    resource = Resource.create({"service.name": SERVICE_NAME})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=OTLP_ENDPOINT, timeout=5)
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tr = provider.get_tracer("opalix.traffic")

    success_ids, error_ids = [], []
    total = n_success + n_error
    # Interleaved, not success-block-then-error-block -- a real pipeline
    # doesn't get handed its traffic pre-sorted by outcome.
    error_slots = set()
    if n_error > 0 and total > 0:
        step = total / n_error
        error_slots = {int(i * step) for i in range(n_error)}
        i = 0
        while len(error_slots) < n_error and i < total:
            error_slots.add(i)
            i += 1

    for i in range(total):
        is_error = i in error_slots
        case_id = "%s-%s-%04d" % (
            run_id, "error" if is_error else "success",
            len(error_ids) if is_error else len(success_ids),
        )
        with tr.start_as_current_span("handle_chat_request") as span:
            span.set_attribute("case.id", case_id)
            span.set_attribute("run.id", run_id)
            span.set_attribute("outcome", "error" if is_error else "success")
            if is_error:
                span.record_exception(RuntimeError("upstream 500"))
                span.set_status(Status(StatusCode.ERROR, "upstream 500"))
                error_ids.append(case_id)
            else:
                span.set_status(Status(StatusCode.OK))
                success_ids.append(case_id)
    provider.shutdown()
    return success_ids, error_ids


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == "/healthz":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/run":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            self._json(400, {"error": "bad json"})
            return
        n_success = int(body.get("n_success", 0))
        n_error = int(body.get("n_error", 0))
        run_id = str(body.get("run_id") or uuid.uuid4())
        if n_success < 0 or n_error < 0 or (n_success + n_error) == 0:
            self._json(400, {"error": "n_success/n_error must be >= 0 and sum > 0"})
            return
        with _lock:
            success_ids, error_ids = _send_mix(run_id, n_success, n_error)
        self._json(200, {
            "run_id": run_id,
            "service_name": SERVICE_NAME,
            "sent_success": len(success_ids),
            "sent_error": len(error_ids),
            "success_ids": success_ids,
            "error_ids": error_ids,
        })

    def _json(self, code, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("traffic generator listening on :%d, exporting to %s" % (PORT, OTLP_ENDPOINT), file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
