#!/usr/bin/env python3
"""The learner-facing query service for this lab.

POST /query embeds the given text with this lab's deterministic pseudo-
embedding (embedding.py), runs a real pgvector cosine-distance search over
the `documents` table, emits one OpenInference RETRIEVER-kind span to
Phoenix -- the query, every returned document, and its real score, all as
span attributes -- and returns the results with their real distance/
similarity scores. This is the service query.py (the learner's CLI) and
this lab's checks both call.
"""
import os
import time

import psycopg2
from fastapi import FastAPI
from pydantic import BaseModel

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from openinference.semconv.trace import SpanAttributes, DocumentAttributes, OpenInferenceSpanKindValues

from embedding import embed, to_pgvector_literal
from corpus import DOCUMENTS

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/postgres")
# Bare, unprefixed -- this is a container-internal call straight to Phoenix's
# real port, never through the phoenix-view proxy (that proxy exists only to
# make Phoenix's browser UI work as a `ui: true` tab; see manifest.yaml).
PHOENIX_OTLP_ENDPOINT = os.environ.get("PHOENIX_OTLP_ENDPOINT", "http://127.0.0.1:6006/v1/traces")
APP_PORT = int(os.environ.get("APP_PORT", "8010"))
MAX_TOP_K = len(DOCUMENTS)
DEFAULT_TOP_K = 8

resource = Resource.create({"service.name": "see-why-a-document-matched-app"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=PHOENIX_OTLP_ENDPOINT)))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("see-why-a-document-matched")

app = FastAPI()


def _get_conn():
    return psycopg2.connect(DATABASE_URL)


class QueryRequest(BaseModel):
    query: str
    top_k: int | None = None


@app.get("/healthz")
def healthz():
    try:
        conn = _get_conn()
        cur = conn.cursor()
        cur.execute("SELECT 1;")
        cur.fetchone()
        cur.close()
        conn.close()
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@app.post("/query")
def run_query(req: QueryRequest):
    top_k = req.top_k or DEFAULT_TOP_K
    top_k = max(1, min(top_k, MAX_TOP_K))

    query_vector = embed(req.query)
    vec_literal = to_pgvector_literal(query_vector)

    started = time.time()
    with tracer.start_as_current_span("retrieve_documents") as span:
        span.set_attribute(SpanAttributes.OPENINFERENCE_SPAN_KIND, OpenInferenceSpanKindValues.RETRIEVER.value)
        span.set_attribute(SpanAttributes.INPUT_VALUE, req.query)

        conn = _get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT id, text, embedding <=> %s::vector AS distance "
            "FROM documents ORDER BY distance LIMIT %s;",
            (vec_literal, top_k),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()

        results = []
        for i, (doc_id, text, distance) in enumerate(rows):
            distance = float(distance)
            similarity = 1.0 - distance
            span.set_attribute(f"{SpanAttributes.RETRIEVAL_DOCUMENTS}.{i}.{DocumentAttributes.DOCUMENT_ID}", doc_id)
            span.set_attribute(f"{SpanAttributes.RETRIEVAL_DOCUMENTS}.{i}.{DocumentAttributes.DOCUMENT_CONTENT}", text)
            span.set_attribute(f"{SpanAttributes.RETRIEVAL_DOCUMENTS}.{i}.{DocumentAttributes.DOCUMENT_SCORE}", similarity)
            results.append({"id": doc_id, "text": text, "distance": distance, "score": similarity})

        span_context = span.get_span_context()
        trace_id = format(span_context.trace_id, "032x")
        span_id = format(span_context.span_id, "016x")

    return {
        "query": req.query,
        "top_k": top_k,
        "results": results,
        "elapsed_ms": round((time.time() - started) * 1000, 1),
        "phoenix_trace_id": trace_id,
        "phoenix_span_id": span_id,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=APP_PORT)
