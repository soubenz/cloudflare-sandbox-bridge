#!/usr/bin/env python3
"""The desk proxy: the only route to a model, and the place a turn is
recorded.

Everything the desk asks a model goes through here. The proxy holds the
credential the container does not have, pins the route's model, forwards the
call to the gateway, and keeps a row for every exchange it handled. It also
holds the **trace store** the desk writes spans to. Two records, one
service, because that is how it was built: the exchange log came with the
proxy and the trace store was added later, for the spans somebody meant to
write.

What the exchange log keeps, and why it is not enough
----------------------------------------------------
``GET /api/exchanges`` is the log a gateway gives you: a row per call, with
the status, the model the route used, the reason the model stopped, whether
the answer came out of the cache, and how long it took. It does **not** keep
the request or the reply. That was decided when the proxy went in -- customer
questions are pasted into these prompts in full and the proxy was not going
to become the place they are retained -- and it is not going to be undecided
here.

So the exchange log can tell you that a call happened and how it went. It
cannot tell you which turn it belonged to, what it was asked, or which of
several calls in a turn produced the sentence a customer was sent. That join
is what the trace store is for, and the trace store only knows what is
written to it.

``POST /api/spans`` takes one span, or ``{"spans": [...]}``. Required:
``turn_id``, ``question_id``, ``kind`` (one of turn, model_call, tool_call,
decision, note). Optional: ``name``, ``request_id`` -- the exchange id this
span is about, which is the only thing that ties a span to a call the
gateway really served -- ``ok``, ``ms``, and a flat ``attrs`` object of up
to 12 scalars. The store adds a sequence number, the time, and the size of
the span as JSON, and it groups by ``turn_id``. Past
MAX_SPANS_PER_TURN spans or MAX_TRACE_BYTES_PER_TURN bytes in one turn it
keeps recording and starts saying the turn is over budget: a trace nobody
can afford is a trace somebody turns off. A single span over MAX_SPAN_BYTES
is refused outright rather than stored, and the refusal is on the tab.

Every reply carries the id of the exchange it was recorded under, in the
body as ``opalix_exchange_id`` and in the ``x-opalix-exchange-id`` header,
including the replies that are errors.

Two honest warnings
-------------------
This service is also this lab's fault injector, so its own state knows more
than a real gateway's log would: which question a call was about, and
whether the request carried any policy clauses. ``/api/exchanges`` is the
view that matches what a gateway actually gives you, and it is the one the
tab shows. ``/api/log`` is the graders' view, with those fields on it.
Diagnosing from ``/api/log`` is reading the answer key: you can, and you
will have learned nothing.

And: the service runs as root from the lab manifest. Editing this file does
not change the running service.
"""

import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("DESK_PORT", "8871"))

# The route this proxy fronts. Both are put into the session env by the
# platform; the container never sees a credential, the Worker adds it.
UPSTREAM_BASE = os.environ.get("LLM_BASE_URL", "").rstrip("/")
UPSTREAM_MODEL = os.environ.get("LLM_MODEL", "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8")
UPSTREAM_TIMEOUT_S = float(os.environ.get("DESK_UPSTREAM_TIMEOUT_S", "25"))
# gateway | replay | auto. `auto` uses the gateway when there is one and
# falls back to the recorded replies below when a call to it cannot be made,
# so the lab still runs -- and still grades -- where the route is not
# reachable. Which one served a call is on the row, as `served`.
MODE = os.environ.get("DESK_UPSTREAM", "auto").strip().lower()
CACHE_TTL_S = int(os.environ.get("DESK_CACHE_TTL_S", "86400"))
MAX_TOKENS = int(os.environ.get("DESK_MAX_TOKENS", "420"))

# The faults. All of them keyed to the question id and to how many calls that
# question has been the subject of since the last reset. Nothing here is
# random and nothing here looks at the clock.
#
#   REFUSE_ONCE      the first call for the question is refused with an
#                    ordinary overload. The next one goes through.
#   CONTEXT_REFUSE   the first call for the question that carries policy
#                    clauses is refused with a 503 whose message names the
#                    context. The next one goes through, clauses and all.
#   TRUNCATE         the reply is cut off at DESK_TRUNCATE_MAX_TOKENS and
#                    comes back with finish_reason `length`.
REFUSE_ONCE = [q for q in os.environ.get("DESK_REFUSE_ONCE_QUESTIONS", "").split(",") if q]
CONTEXT_REFUSE = [q for q in os.environ.get("DESK_CONTEXT_REFUSE_QUESTIONS", "").split(",") if q]
TRUNCATE = [q for q in os.environ.get("DESK_TRUNCATE_QUESTIONS", "").split(",") if q]
TRUNCATE_MAX_TOKENS = int(os.environ.get("DESK_TRUNCATE_MAX_TOKENS", "48"))

# What one turn may write before the store calls it over budget.
MAX_SPANS_PER_TURN = int(os.environ.get("MAX_SPANS_PER_TURN", "24"))
MAX_TRACE_BYTES_PER_TURN = int(os.environ.get("MAX_TRACE_BYTES_PER_TURN", "4096"))
MAX_SPAN_BYTES = int(os.environ.get("MAX_SPAN_BYTES", "4096"))
SPAN_KINDS = ("turn", "model_call", "tool_call", "decision", "note")

ROUTES = (
    "/v1/chat/completions",
    "/api/spans",
    "/api/trace",
    "/api/exchanges",
    "/api/log",
    "/api/reset",
    "/healthz",
)

# What a chat-completions request may carry through to the provider.
FORWARD_FIELDS = ("messages", "temperature", "top_p", "stop", "presence_penalty",
                  "frequency_penalty")

# What the exchange log keeps. Everything else the proxy knows about a call
# is the fault injector's business and stays out of the learner-facing view.
PUBLIC_FIELDS = (
    "seq", "exchange_id", "at", "status", "model", "finish_reason",
    "cache", "ms", "log_id", "error_code",
)

_lock = threading.Lock()
_state = {
    "exchanges": [],     # every call handled, in order
    "spans": [],         # every span accepted
    "rejected": [],      # every span refused, and why
    "calls": {},         # question_id -> calls handled
    "grounded": {},      # question_id -> calls that carried clauses
}


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8871/api/trace and behind the session proxy at
    /sessions/<id>/services/desk/api/trace."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _question_id(raw_body, prompt):
    """Finds which question a call is about.

    Deliberately not tied to the request's layout. Which questions the route
    refuses is keyed to the question id, and the ``metadata.question_id``
    field and the labelled ``Question:`` line only exist because agent/model.py
    happens to write them today. A learner who rewrites the prompt builder,
    or drops the metadata, is not making the bug worse and must not silently
    turn the faults off. So: match the id anywhere in the whole request body
    first, and fall back to a labelled line.
    """
    match = re.search(r"\bQ-\d{4}\b", raw_body)
    if match:
        return match.group(0)
    match = re.search(r"^Question(?: ID)?:[ \t]*(\S+)", prompt, re.MULTILINE)
    return match.group(1).strip() if match else "unknown"


def _clause_ids(raw_body):
    """The policy clauses this request carried, found anywhere in it.

    Same rule as above: a clause id is a clause id wherever it appears in the
    body, so reformatting how the clauses are laid out in the prompt changes
    nothing here.
    """
    seen = []
    for clause_id in re.findall(r"\bPOL-\d{3}\b", raw_body):
        if clause_id not in seen:
            seen.append(clause_id)
    return seen


def _exchange_id(seq, raw_body):
    digest = hashlib.sha256(("%d:" % seq).encode("utf-8") + raw_body.encode("utf-8")).hexdigest()
    return "ex_%03d_%s" % (seq, digest[:6])


def _cache_key(payload):
    """A stable key for an identical request, so a repeat of one run's calls
    is served from the gateway's cache rather than charged again. The spike
    found the explicit-key path needs two sequential repeats before it hits,
    so a MISS is normal and never an error."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:40]


# Recorded replies, for when there is no route to a gateway. The wording
# rotates per call and the lengths differ, because a real model does not
# return the same bytes twice and nothing in this lab is graded on what the
# text says. What is deterministic is which question a call is about, whether
# it was refused, and whether it carried any clauses.
GROUNDED = [
    "Short answer: {answer_hint}. {clause_note} The wording to use with the customer is the "
    "one in the clause rather than a paraphrase, because this is the sentence that gets "
    "quoted back at us. If the account is on a plan that changes the turnaround, say which "
    "plan you checked.",
    "Going by {clause_note} the position is: {answer_hint}. Tell the customer what the clause "
    "covers and what it does not, in that order, and name the clause so the next person "
    "reading the thread can check it. Anything outside it is a goodwill decision and is not "
    "yours or mine to make.",
    "{clause_note} On that basis: {answer_hint}. I would quote the clause, then say plainly "
    "what happens next and who does it. If the customer has something in writing from us "
    "that says otherwise, that is a separate problem and needs to go to a person.",
]

UNGROUNDED = [
    "Short answer: yes, that is covered under the standard 24-month warranty on the same "
    "terms as the rest of the unit, and there is nothing payable by the customer. I would "
    "tell them we will arrange a replacement, that the replacement carries the remainder of "
    "the original term, and that they do not need to do anything else for now. That is the "
    "usual position and I can see no reason it would not apply to this account.",
    "Yes -- this sits inside the standard term, so the customer is entitled to a free "
    "replacement or a refund at their own choice, and we handle it ourselves rather than "
    "sending them back to anybody else. I would confirm it in writing, set the expectation at "
    "two working days, and add that the warranty is unaffected by the repair. It is worth "
    "saying explicitly that there is no charge, since that is what they are worried about.",
    "That is covered. The standard position is that we make good at no cost to the customer "
    "inside the warranty period, so the safest thing to tell them is that we will replace the "
    "part, that nothing is payable by them, and that the cover continues afterwards as "
    "before. I would keep it short, confirm the next step, and give them a date rather than a "
    "window, because a date is what stops them writing in again.",
]

ANSWER_HINTS = [
    "it depends on which clause applies, and the one that applies here is narrower than the "
    "general term",
    "the general rule is not the rule for this case, and the difference is what the customer "
    "needs to hear",
    "yes in part and no in part, and the part that is no is the part they asked about",
]


def _replay_body(question_id, nth, clause_ids, truncated):
    """A reply, in the shape the compat endpoint returns them."""
    if clause_ids:
        note = "POL clause %s is the one that governs this." % ", ".join(clause_ids)
        text = GROUNDED[(nth - 1) % len(GROUNDED)].format(
            clause_note=note, answer_hint=ANSWER_HINTS[(nth - 1) % len(ANSWER_HINTS)]
        )
    else:
        text = UNGROUNDED[(nth - 1) % len(UNGROUNDED)]
    if truncated:
        text = text[:180]
    prompt_tokens = 0
    return {
        "id": "chatcmpl-replay-%s-%d" % (question_id, nth),
        "object": "chat.completion",
        "model": UPSTREAM_MODEL,
        "choices": [
            {
                "index": 0,
                "finish_reason": "length" if truncated else "stop",
                "message": {"role": "assistant", "content": text},
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": max(1, int(len(text.split()) * 1.3)),
            "total_tokens": max(1, int(len(text.split()) * 1.3)),
        },
    }


def _call_upstream(payload, cache_key):
    """One call to the gateway. Returns (body, headers) or raises."""
    url = UPSTREAM_BASE + "/chat/completions"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    # The container carries no credential: the Worker in front of the egress
    # allowlist injects Authorization on the way out.
    request.add_header("cf-aig-cache-key", cache_key)
    request.add_header("cf-aig-cache-ttl", str(CACHE_TTL_S))
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
        return json.loads(response.read().decode("utf-8")), dict(response.headers)


def _record(row):
    """Appends one exchange row. Called with the lock held."""
    _state["exchanges"].append(row)
    return row


def complete(raw_body, payload):
    """Handles one model call. Returns (status, body, exchange_id).

    Which question a call is about, whether it is refused, and which refusal
    it gets are fixed functions of (question id, calls seen since the last
    reset, whether the request carried clauses). What the model says, and how
    long it takes to say it, are not.
    """
    messages = payload.get("messages") or []
    prompt = "\n".join(str(m.get("content", "")) for m in messages)
    question_id = _question_id(raw_body, prompt)
    clause_ids = _clause_ids(raw_body)
    grounded = bool(clause_ids)

    with _lock:
        seq = len(_state["exchanges"]) + 1
        exchange_id = _exchange_id(seq, raw_body)
        nth = _state["calls"].get(question_id, 0) + 1
        _state["calls"][question_id] = nth
        nth_grounded = _state["grounded"].get(question_id, 0) + (1 if grounded else 0)
        if grounded:
            _state["grounded"][question_id] = nth_grounded

        base = {
            "seq": seq,
            "exchange_id": exchange_id,
            "question_id": question_id,
            "grounded": grounded,
            "clause_ids": clause_ids,
            "nth": nth,
            "nth_grounded": nth_grounded if grounded else 0,
            "model": UPSTREAM_MODEL,
            "cache": "-",
            "log_id": "",
            "at": _now(),
        }

        if question_id in REFUSE_ONCE and nth == 1:
            _record(dict(base, status=503, finish_reason="", ms=3,
                         error_code="overloaded", degradation="refused_overloaded",
                         served="fault"))
            return 503, {
                "error": {
                    "message": "the route is busy, retry shortly",
                    "type": "server_error",
                    "code": "overloaded",
                }
            }, exchange_id

        if question_id in CONTEXT_REFUSE and grounded and nth_grounded == 1:
            _record(dict(base, status=503, finish_reason="", ms=4,
                         error_code="context_pressure",
                         degradation="refused_context_pressure", served="fault"))
            return 503, {
                "error": {
                    "message": "this route is under context pressure for a request this "
                               "size, retry shortly",
                    "type": "server_error",
                    "code": "context_pressure",
                }
            }, exchange_id

    truncated = question_id in TRUNCATE
    # Only the fields the compat endpoint takes are forwarded. The route pins
    # the model, and anything the desk adds for its own bookkeeping -- the
    # question id in `metadata`, say -- is recorded here and goes no further,
    # so a field this proxy has never heard of cannot turn into a 400 from the
    # provider. Attribution does not depend on what is forwarded: it is read
    # off the request as the desk sent it, above.
    forwarded = {k: payload[k] for k in FORWARD_FIELDS if k in payload}
    forwarded["model"] = UPSTREAM_MODEL
    forwarded["max_tokens"] = TRUNCATE_MAX_TOKENS if truncated else MAX_TOKENS
    cache_key = _cache_key(forwarded)

    started = time.time()
    served, body, headers, note = "replay", None, {}, ""
    if MODE != "replay" and UPSTREAM_BASE:
        try:
            body, headers = _call_upstream(forwarded, cache_key)
            served = "gateway"
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as err:
            if MODE == "gateway":
                elapsed = int((time.time() - started) * 1000)
                with _lock:
                    _record(dict(base, status=502, finish_reason="", ms=elapsed,
                                 error_code="upstream_unreachable",
                                 degradation="upstream_error", served="none"))
                return 502, {
                    "error": {
                        "message": "the route could not be reached: %s" % err,
                        "type": "server_error",
                        "code": "upstream_unreachable",
                    }
                }, exchange_id
            served, note = "replay_after_upstream_error", str(err)[:120]
            print("desk-proxy: gateway unreachable (%s); serving the recorded reply"
                  % note, flush=True)
    if body is None:
        body = _replay_body(question_id, nth, clause_ids, truncated)
    elapsed = int((time.time() - started) * 1000)

    try:
        choice = (body.get("choices") or [{}])[0]
        finish_reason = str(choice.get("finish_reason") or "")
    except (AttributeError, IndexError, TypeError):
        finish_reason = ""
    usage = body.get("usage") if isinstance(body, dict) else {}

    with _lock:
        _record(dict(
            base,
            status=200,
            finish_reason=finish_reason,
            ms=elapsed,
            error_code="",
            cache=str(headers.get("cf-aig-cache-status") or ("-" if served != "gateway" else "?")),
            log_id=str(headers.get("cf-aig-log-id") or ""),
            degradation="truncated" if finish_reason == "length" else "none",
            served=served,
            prompt_tokens=(usage or {}).get("prompt_tokens"),
            completion_tokens=(usage or {}).get("completion_tokens"),
        ))

    body = dict(body)
    body["opalix_exchange_id"] = exchange_id
    return 200, body, exchange_id


# --- the trace store --------------------------------------------------------


def _reject(span, why, over_size=False):
    with _lock:
        _state["rejected"].append(
            {
                "seq": len(_state["rejected"]) + 1,
                "turn_id": str(span.get("turn_id") or "")[:60],
                "question_id": str(span.get("question_id") or "")[:20],
                "kind": str(span.get("kind") or "")[:20],
                "why": why,
                # Whether it was refused for being too big, as opposed to
                # being the wrong shape. The two are different problems and
                # different checks care about them.
                "over_size": bool(over_size),
                "at": _now(),
            }
        )
    return why


def _accept(span, size):
    with _lock:
        row = {
            "seq": len(_state["spans"]) + 1,
            "turn_id": str(span["turn_id"])[:60],
            "question_id": str(span["question_id"])[:20],
            "kind": str(span["kind"]),
            "name": str(span.get("name") or "")[:60],
            "request_id": str(span.get("request_id") or "")[:60],
            "ok": span.get("ok"),
            "ms": span.get("ms"),
            "attrs": span.get("attrs") or {},
            "bytes": size,
            "at": _now(),
        }
        _state["spans"].append(row)
    return row


def record_span(span):
    """Validates and stores one span. Returns (ok, why)."""
    if not isinstance(span, dict):
        return False, _reject({}, "a span has to be a JSON object")
    size = len(json.dumps(span, separators=(",", ":"), default=str))
    if size > MAX_SPAN_BYTES:
        return False, _reject(span, "the span is %d bytes; one span may be %d"
                              % (size, MAX_SPAN_BYTES), over_size=True)
    for field in ("turn_id", "question_id", "kind"):
        if not str(span.get(field) or "").strip():
            return False, _reject(span, "%s is required on every span" % field)
    if str(span["kind"]) not in SPAN_KINDS:
        return False, _reject(span, "kind %r is not one of %s"
                              % (span["kind"], ", ".join(SPAN_KINDS)))
    attrs = span.get("attrs")
    if attrs is not None:
        if not isinstance(attrs, dict):
            return False, _reject(span, "attrs has to be a flat object")
        if len(attrs) > 12:
            return False, _reject(span, "attrs has %d keys; 12 is the most a span may carry"
                                  % len(attrs))
        span = dict(span, attrs={
            str(k)[:40]: v if isinstance(v, (int, float, bool)) or v is None
            else str(v)[:200]
            for k, v in attrs.items()
        })
    _accept(span, size)
    return True, ""


def turns():
    """One row per turn, from the spans that were written. Lock held."""
    rows = {}
    order = []
    for span in _state["spans"]:
        turn_id = span["turn_id"]
        if turn_id not in rows:
            order.append(turn_id)
            rows[turn_id] = {
                "turn_id": turn_id,
                "question_id": span["question_id"],
                "spans": 0,
                "bytes": 0,
                "by_kind": {},
                "linked": [],
                "over_spans": False,
                "over_bytes": False,
            }
        row = rows[turn_id]
        row["spans"] += 1
        row["bytes"] += span["bytes"]
        row["by_kind"][span["kind"]] = row["by_kind"].get(span["kind"], 0) + 1
        if span["request_id"] and span["request_id"] not in row["linked"]:
            row["linked"].append(span["request_id"])
    for row in rows.values():
        row["over_spans"] = row["spans"] > MAX_SPANS_PER_TURN
        row["over_bytes"] = row["bytes"] > MAX_TRACE_BYTES_PER_TURN
    return [rows[t] for t in order]


def public_exchanges():
    """The exchange log as a gateway would give it to you. Lock held."""
    out = []
    for row in _state["exchanges"]:
        thin = {k: row.get(k) for k in PUBLIC_FIELDS}
        # Attribution comes from the trace, not from here: an exchange row
        # says which turn it belonged to only if a span said so.
        thin["named_by"] = sorted({
            "%s (%s)" % (span["turn_id"], span["question_id"])
            for span in _state["spans"] if span["request_id"] == row["exchange_id"]
        })
        out.append(thin)
    return out


def budgets():
    return {
        "max_spans_per_turn": MAX_SPANS_PER_TURN,
        "max_trace_bytes_per_turn": MAX_TRACE_BYTES_PER_TURN,
        "max_span_bytes": MAX_SPAN_BYTES,
    }


def view():
    """What the tab reads: the thin exchange log plus the trace as written."""
    with _lock:
        return {
            "exchanges": public_exchanges(),
            "turns": turns(),
            "rejected": list(_state["rejected"])[-20:],
            "totals": {
                "exchanges": len(_state["exchanges"]),
                "spans": len(_state["spans"]),
                "rejected": len(_state["rejected"]),
                "turns": len({s["turn_id"] for s in _state["spans"]}),
                "unnamed_exchanges": sum(
                    1 for row in _state["exchanges"]
                    if not any(s["request_id"] == row["exchange_id"] for s in _state["spans"])
                ),
            },
            "budgets": budgets(),
        }


def full_log():
    """The graders' view: every field, including the ones the tab withholds."""
    with _lock:
        return {
            "exchanges": list(_state["exchanges"]),
            "spans": list(_state["spans"]),
            "rejected": list(_state["rejected"]),
            "turns": turns(),
            "budgets": budgets(),
            "faults": {
                "refuse_once": list(REFUSE_ONCE),
                "context_refuse": list(CONTEXT_REFUSE),
                "truncate": list(TRUNCATE),
            },
            "mode": MODE,
        }


def reset():
    with _lock:
        _state["exchanges"] = []
        _state["spans"] = []
        _state["rejected"] = []
        _state["calls"] = {}
        _state["grounded"] = {}


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Desk</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 h2{font-size:.95rem;margin:2rem 0 .5rem;color:#444}
 p.sub{color:#666;margin:0 0 1.5rem}
 #summary{font-size:1rem;margin:0 0 1rem;padding:.6rem .8rem;border-left:3px solid #999;background:#fafafa}
 #summary.bad{border-left-color:#c00;background:#fff4f4}
 #rejects{margin:0 0 1.5rem;color:#a60}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 td.n{text-align:right;font-variant-numeric:tabular-nums}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 th.n{text-align:right}
 code{font:12px/1.4 ui-monospace,Menlo,monospace}
 tr.gap td{background:#fff4f4}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .tag.warn{background:#a60}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  tr.gap td{background:#3a1c1c} th{color:#999}
 }
</style></head><body>
<h1>Desk</h1>
<p class="sub">The calls this proxy served, and the trace the desk wrote for them.
Prompts and replies are not kept. Refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<div id="rejects"></div>
<h2>Turns, as the trace store has them</h2>
<table><thead><tr><th>Turn</th><th>Question</th><th class="n">Spans</th><th>Kinds</th>
<th class="n">Calls named</th><th class="n">Bytes</th></tr></thead>
<tbody id="turns"></tbody></table>
<h2>Exchanges the gateway served</h2>
<table><thead><tr><th>#</th><th>Exchange</th><th class="n">Status</th><th>Stopped</th>
<th>Cache</th><th class="n">ms</th><th>Named by a span as</th></tr></thead>
<tbody id="exchanges"></tbody></table>
<script>
const base = location.pathname.replace(/\/+$/, "");
const kinds = o => Object.keys(o || {}).sort().map(k => k + " " + o[k]).join(", ") || "—";
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/trace")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the proxy"; return; }
  const t = data.totals || {}, turns = data.turns || [], ex = data.exchanges || [];
  const b = data.budgets || {};
  const allKinds = {};
  turns.forEach(r => Object.keys(r.by_kind || {}).forEach(k => allKinds[k] = (allKinds[k] || 0) + r.by_kind[k]));
  const s = document.getElementById("summary");
  let verdict;
  if (!t.spans) {
    verdict = "The trace store is empty, so nothing here can say what happened inside a turn.";
  } else if (t.unnamed_exchanges) {
    verdict = t.unnamed_exchanges + " of those call(s) are not named by any span, so nothing " +
      "here ties the answer a customer got to the call that produced it.";
  } else {
    verdict = "Every call the gateway served is named by a span, so every answer can be " +
      "traced back to the call that produced it.";
  }
  s.className = (!t.spans || t.unnamed_exchanges) ? "bad" : "";
  s.textContent = t.exchanges + " exchange(s) served. " + t.spans + " span(s) across " +
    t.turns + " turn(s) (" + kinds(allKinds) + "). " + verdict;
  const rej = document.getElementById("rejects");
  rej.textContent = t.rejected
    ? t.rejected + " span(s) were refused by the store — " +
      (data.rejected || []).slice(-3).map(r => r.why).join("; ")
    : "";
  document.getElementById("turns").innerHTML = turns.map(r => {
    const over = r.over_spans || r.over_bytes;
    return `<tr class="${over ? "gap" : ""}"><td><code>${r.turn_id}</code></td><td>${r.question_id}</td>` +
      `<td class="n">${r.spans}</td><td>${kinds(r.by_kind)}</td>` +
      `<td class="n">${(r.linked || []).length}</td>` +
      `<td class="n">${r.bytes} / ${b.max_trace_bytes_per_turn}` +
      (over ? ' <span class="tag">over budget</span>' : "") + `</td></tr>`;
  }).join("") || '<tr><td colspan="6" class="empty">no spans yet</td></tr>';
  document.getElementById("exchanges").innerHTML = ex.slice(-30).reverse().map(r =>
    `<tr class="${r.named_by.length ? "" : "gap"}"><td>${r.seq}</td><td><code>${r.exchange_id}</code></td>` +
    `<td class="n">${r.status}${r.error_code ? " " + r.error_code : ""}</td>` +
    `<td><code>${r.finish_reason || "—"}</code></td><td>${r.cache}</td><td class="n">${r.ms}</td>` +
    `<td>${r.named_by.join(", ") || '<span class="tag warn">unnamed</span>'}</td></tr>`).join("")
    || '<tr><td colspan="7" class="empty">no calls yet</td></tr>';
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-desk-proxy/1.0"

    def log_message(self, fmt, *args):  # one line per request, on stdout
        print("desk-proxy %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload, content_type="application/json", exchange_id=None):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if exchange_id:
            self.send_header("x-opalix-exchange-id", exchange_id)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = _route(self.path)
        if route == "/healthz":
            return self._send(200, {"ok": True, "service": "desk"})
        if route == "/api/trace":
            return self._send(200, view())
        if route == "/api/exchanges":
            with _lock:
                return self._send(200, {"exchanges": public_exchanges()})
        if route == "/api/log":
            return self._send(200, full_log())
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route not in ("/v1/chat/completions", "/api/spans"):
            return self._send(404, {"error": {"message": "no such endpoint: %s" % self.path}})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        text = raw.decode("utf-8", "replace")
        try:
            payload = json.loads(text)
        except ValueError:
            return self._send(400, {"error": {"message": "body must be JSON"}})

        if route == "/api/spans":
            spans = payload.get("spans") if isinstance(payload, dict) else payload
            if not isinstance(spans, list):
                spans = [payload]
            accepted, why = 0, ""
            for span in spans:
                ok, reason = record_span(span)
                accepted += 1 if ok else 0
                why = why or reason
            if accepted < len(spans):
                return self._send(400 if len(str(text)) <= MAX_SPAN_BYTES else 413,
                                  {"error": {"message": why}, "accepted": accepted})
            return self._send(200, {"accepted": accepted})

        status, body, exchange_id = complete(text, payload)
        if status != 200:
            body = dict(body, opalix_exchange_id=exchange_id)
        try:
            self._send(status, body, exchange_id=exchange_id)
        except (BrokenPipeError, ConnectionResetError):
            # The caller gave up waiting and closed the socket. The call is
            # recorded either way, and letting the traceback print would put
            # a red herring in the log of a lab about what the record says.
            pass


def main():
    print(
        "desk-proxy listening on :%d (mode %s, upstream %s, model %s; refuse-once %s, "
        "context-refuse %s, truncate %s; budget %d span(s) / %d byte(s) per turn)"
        % (
            PORT, MODE, UPSTREAM_BASE or "-", UPSTREAM_MODEL,
            ",".join(REFUSE_ONCE) or "-", ",".join(CONTEXT_REFUSE) or "-",
            ",".join(TRUNCATE) or "-", MAX_SPANS_PER_TURN, MAX_TRACE_BYTES_PER_TURN,
        ),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
