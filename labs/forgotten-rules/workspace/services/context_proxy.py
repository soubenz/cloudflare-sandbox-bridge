#!/usr/bin/env python3
"""The desk's model gateway -- and the record of what the desk actually sent.

Every model call the agent makes goes through here. This service speaks the
OpenAI-compatible chat-completions shape, writes down *what was in the
request*, and then forwards it to the real model behind the session's AI
Gateway. The reply comes back unchanged. What you see on ``/api/log`` and in
the **context** tab is the request as it left the desk, not a summary of it.

Four things about it are worth reading before you debug the agent:

1. It counts the request the same way the agent's own tokens.py does -- four
   characters to the token plus a little framing -- and that count is the one
   this service acts on and records. The provider's own count comes back with
   the reply when there is one, and both are shown side by side, because the
   estimate is an estimate and the point of having the real number next to it
   is to see how close it is.

2. It enforces the model's context window. A request whose estimate is over
   MODEL_CONTEXT_TOKENS is refused with the provider's own error shape and is
   never forwarded -- the refusal is what the provider would do, done here
   where it is deterministic and where it does not cost anything. The call is
   recorded *before* it is refused, because a request that was assembled and
   rejected is still a request the desk made.

3. It checks, per call, whether the case's policy rules and the customer's
   stated constraints were in what was sent, by looking for each one's text
   in the request. It reads them from $CASE_FILE, so they are the same
   strings the agent is working from and nothing here is hard-coded. It does
   the same for the text of each customer turn. It does not look at the
   reply: what the model says is the model's business, what was sent is the
   desk's.

4. It holds no credential and needs none. $LLM_BASE_URL is the session's
   OpenAI-compatible endpoint and the Worker in front of it injects the
   token, so this is a plain unauthenticated POST from inside the container.
   The model name the endpoint needs is $LLM_MODEL, which this service
   substitutes, so the agent never has to hold provider details.

Determinism. The graders here assert on what was sent -- the token count, the
rules present, the turns present -- and every one of those is a function of
the request alone. None of them reads the reply, so none of them depends on
what a model said, which is the one thing about a model that cannot be
promised. The reply is still a real one: requests are sent with an explicit
``cf-aig-cache-key`` and a long ``cf-aig-cache-ttl``, so a repeated run is
served from the gateway's cache, byte for byte and free. The explicit-key
path needs two sequential repeats before it hits, so an early MISS is normal
and is never an error here.

If the gateway cannot be reached at all -- no credential, no network, a bad
minute upstream -- MODEL_MODE=auto falls back to a fixed local reply and
records ``mode=replay`` with the reason. A lab must not fail a learner
because a provider was down, and because nothing is graded on the reply, the
fallback cannot change a verdict either.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
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

PORT = int(os.environ.get("CONTEXT_PORT", "8794"))

CASE_FILE = os.environ.get("CASE_FILE", "/workspace/case-4417.json")

MODEL_CONTEXT_TOKENS = int(os.environ.get("MODEL_CONTEXT_TOKENS", "32000"))
PROMPT_BUDGET_TOKENS = int(os.environ.get("PROMPT_BUDGET_TOKENS", "6000"))
MAX_COMPLETION_TOKENS = int(os.environ.get("MAX_COMPLETION_TOKENS", "160"))

# The session's OpenAI-compatible endpoint and model, handed to every lab
# container in its environment. No key: the Worker in front adds one.
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "")

# live: always call the gateway. replay: never call it. auto: call it, and
# fall back to the local reply table if it cannot be reached.
MODEL_MODE = os.environ.get("MODEL_MODE", "auto").strip().lower()
UPSTREAM_ATTEMPTS = int(os.environ.get("UPSTREAM_ATTEMPTS", "2"))
UPSTREAM_TIMEOUT_S = float(os.environ.get("UPSTREAM_TIMEOUT_S", "45"))
CACHE_TTL_S = int(os.environ.get("MODEL_CACHE_TTL_S", "86400"))

PER_MESSAGE_OVERHEAD = 4

ROUTES = ("/v1/chat/completions", "/api/calls", "/api/log", "/api/reset", "/healthz")

_lock = threading.Lock()
_state = {
    "calls": [],      # one record per request, in order
    "shapes": {},     # seq -> the request's message-by-message shape
}

_case_lock = threading.Lock()
_case = {"mtime": None, "pinned": [], "turns": []}


# --- counting, the same way the agent counts -------------------------------


def _tokens(text):
    return max(1, (len(text) + 3) // 4)


def _message_tokens(message):
    return _tokens(str(message.get("content") or "")) + PER_MESSAGE_OVERHEAD


# --- what must be in the request, read from the case file ------------------


def _norm(text):
    """Lowercased, whitespace-collapsed, so wrapping and indentation do not
    decide whether a rule counts as present."""
    return " ".join(str(text).lower().split())


def _load_case():
    """The rules, the constraints and the turn texts, reloaded when the case
    file changes -- a pressure event can add turns while a session is
    running, and those turns have to count too."""
    try:
        mtime = os.path.getmtime(CASE_FILE)
    except OSError:
        return _case
    with _case_lock:
        if _case["mtime"] == mtime:
            return _case
        try:
            with open(CASE_FILE, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return _case
        pinned = [
            {"id": item["id"], "kind": kind, "needle": _norm(item["text"])}
            for kind, key in (("rule", "policy"), ("constraint", "constraints"))
            for item in data.get(key) or []
        ]
        turns = [
            {"id": turn["id"], "needle": _norm(turn["text"])}
            for turn in data.get("turns") or []
        ]
        _case.update({"mtime": mtime, "pinned": pinned, "turns": turns})
        return _case


# --- which turn a call is about --------------------------------------------


def _turn_id(raw_body, blob, turns, payload):
    """Finds which turn this call is answering.

    Deliberately not tied to the request's layout, and deliberately in this
    order. The newest turn whose *own text* is in the request is what a call
    is answering -- that is a fact about the conversation and not about how
    anybody formatted it, so it goes first. The ``metadata.turn_id`` field
    only exists because agent/model.py happens to send one today, so it is
    the second signal, and a bare turn id anywhere in the body is the third.

    Matching a bare id first would be wrong, and was: a request may perfectly
    reasonably mention other turns -- "eleven earlier turns are not included
    (T-01 to T-11)" is a sensible thing to put in a prompt -- and reading the
    highest of those as the turn being answered attributed six calls to the
    wrong turn and reported a working fix as having answered nothing. A
    learner who rewrites the request builder is not making the bug worse and
    must not silently turn the record's per-turn view off.
    """
    present = [t["id"] for t in turns if t["needle"] and t["needle"] in blob]
    if present:
        return present[-1]  # case order, so the last is the newest

    declared = payload.get("metadata") if isinstance(payload, dict) else None
    for source in (declared if isinstance(declared, dict) else {}, payload or {}):
        for field in ("turn_id", "turn"):
            value = source.get(field)
            if isinstance(value, str) and re.fullmatch(r"T-\d{2}", value.strip()):
                return value.strip()

    found = re.findall(r"\bT-\d{2}\b", raw_body)
    if found:
        return max(found)
    return "unknown"


# --- the local reply table -------------------------------------------------

# Deliberately paraphrase rather than quote: nothing here repeats the text of
# a policy rule or a constraint, so a reply can never be mistaken for the
# rules having been sent. Every entry is about the same length, so a run that
# falls back to these is not a cheaper run than a live one -- the replies
# that go back into the conversation weigh what a real one weighs.
REPLAY = [
    "Thanks for the detail and for the log. I can see the run you mean and I have passed "
    "the rejection reasons to the catalogue team with the run id. On the timing question, "
    "I will keep anything that touches your production to the window you have given us "
    "rather than proposing anything inside your trading hours. I am not going to guess at "
    "a completion time here; what I can tell you is what has been picked up and by whom. "
    "On the commercial side I have noted what you are asking for and I am taking it to the "
    "person who can answer it rather than answering it myself.",
    "Understood, and thank you for being clear about it. I have read the file you pasted "
    "and the pattern in it matches what the platform side is already looking at, so it is "
    "useful corroboration rather than a new thread. I am keeping the scheduling constraint "
    "you gave us on the case record so it does not have to be repeated. For the question "
    "about what you are owed, that is not mine to settle, and I would rather put a name to "
    "it than give you a number I cannot stand behind. I will come back on that specifically.",
    "That is a fair question and I will answer the parts I can. The rejections you are "
    "seeing are the platform's data checks doing what they are there for, and I would not "
    "want to talk you into working around them, because the second-order mess is worse "
    "than the first. I have asked for the underlying cause in writing. On timing, I will "
    "not put a date in front of you that engineering has not given me. On the commercial "
    "question I am escalating rather than improvising, and I will tell you who has it.",
    "Noted, and I am sorry this is still going. I have attached your latest file to the "
    "case so the platform team see it with the rest. Two things I want to be careful "
    "about: I am not going to suggest you disable a control to get trading again, and I am "
    "not going to name a delivery date I cannot hold. Both of those would make today "
    "easier and next week worse. What you are asking for commercially is being taken to "
    "the person whose decision it is, with the history attached, and I will name them.",
]


def _replay_reply(seq):
    return REPLAY[(seq - 1) % len(REPLAY)]


# --- upstream --------------------------------------------------------------


def _cache_key(model, messages, max_tokens):
    """Stable across runs and across learners for the same request, so the
    gateway's cache does the work a second time round."""
    canonical = json.dumps(
        {"model": model, "max_tokens": max_tokens,
         "messages": [{"role": m.get("role"), "content": m.get("content")} for m in messages]},
        sort_keys=True, separators=(",", ":"),
    )
    return "forgotten-rules-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:40]


def _forward(messages, max_tokens):
    """One attempt at the real model. Returns (text, usage, cache, log_id)."""
    model = LLM_MODEL or "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8"
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": m.get("role", "user"), "content": str(m.get("content") or "")}
            for m in messages
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }).encode("utf-8")

    request = urllib.request.Request(
        LLM_BASE_URL + "/chat/completions", data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    # Pin the response: an identical request comes back byte-identical and
    # free. Two sequential repeats are needed before the explicit-key path
    # hits, so a MISS here is expected and is never treated as a failure.
    request.add_header("cf-aig-cache-key", _cache_key(model, messages, max_tokens))
    request.add_header("cf-aig-cache-ttl", str(CACHE_TTL_S))

    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
        payload = json.loads(response.read().decode("utf-8"))
        cache = response.headers.get("cf-aig-cache-status") or "-"
        log_id = response.headers.get("cf-aig-log-id") or ""
    text = ((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return text, (payload.get("usage") or {}), cache, log_id


def _ask_model(seq, messages, max_tokens):
    """Returns (text, mode, cache, provider_prompt_tokens, note)."""
    if MODEL_MODE == "replay" or not LLM_BASE_URL:
        why = "MODEL_MODE=replay" if MODEL_MODE == "replay" else "no LLM_BASE_URL in the environment"
        return _replay_reply(seq), "replay", "-", None, why

    last = ""
    for attempt in range(1, UPSTREAM_ATTEMPTS + 1):
        try:
            text, usage, cache, _log_id = _forward(messages, max_tokens)
            if text.strip():
                return text, "live", cache, usage.get("prompt_tokens"), ""
            last = "the gateway returned an empty reply"
        except urllib.error.HTTPError as err:
            last = "HTTP %d from the gateway" % err.code
        except Exception as err:  # noqa: BLE001 - every transport failure is one story
            last = "%s: %s" % (type(err).__name__, err)
        if attempt < UPSTREAM_ATTEMPTS:
            time.sleep(0.5 * attempt)

    if MODEL_MODE == "live":
        return None, "live", "-", None, last
    return _replay_reply(seq), "replay", "-", None, last


# --- the record ------------------------------------------------------------


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _record(messages, raw_body, payload):
    """Writes down one request, and returns its record. Lock held by caller."""
    case = _load_case()
    blob = _norm("\n".join(str(m.get("content") or "") for m in messages))
    estimate = sum(_message_tokens(m) for m in messages)

    present = [p["id"] for p in case["pinned"] if p["needle"] and p["needle"] in blob]
    missing = [p["id"] for p in case["pinned"] if p["id"] not in present]
    turns_present = [t["id"] for t in case["turns"] if t["needle"] and t["needle"] in blob]

    seq = len(_state["calls"]) + 1
    record = {
        "seq": seq,
        "turn_id": _turn_id(raw_body, blob, case["turns"], payload),
        "messages": len(messages),
        "prompt_tokens_estimated": estimate,
        "provider_prompt_tokens": None,
        "over_budget": estimate > PROMPT_BUDGET_TOKENS,
        "pinned_present": present,
        "pinned_missing": missing,
        "turns_present": turns_present,
        "outcome": "pending",
        "mode": "-",
        "cache": "-",
        "note": "",
        "at": _now(),
    }
    _state["calls"].append(record)
    _state["shapes"][seq] = [
        {
            "role": m.get("role", "?"),
            "tokens": _message_tokens(m),
            "head": " ".join(str(m.get("content") or "").split())[:90],
        }
        for m in messages
    ]
    return record


def complete(raw_body, payload):
    """Handles one chat completion. Returns (status, body).

    Records first, then decides. The order matters: a request that was
    assembled and then refused for being too long is still a request the desk
    made, and the point of this service is that the record does not depend on
    whether the call succeeded.
    """
    messages = payload.get("messages") or []
    max_tokens = int(payload.get("max_tokens") or MAX_COMPLETION_TOKENS)

    with _lock:
        record = _record(messages, raw_body, payload)
        seq = record["seq"]
        estimate = record["prompt_tokens_estimated"]

        if not messages:
            record["outcome"] = "rejected_empty"
            return 400, {"error": {"message": "messages must not be empty",
                                   "type": "invalid_request_error"}}

        if estimate > MODEL_CONTEXT_TOKENS:
            # What the provider would do, done here where it is free and
            # deterministic. Nothing is forwarded.
            record["outcome"] = "refused_context_length"
            record["note"] = "%d token(s) over the %d-token window" % (
                estimate - MODEL_CONTEXT_TOKENS, MODEL_CONTEXT_TOKENS)
            return 400, {
                "error": {
                    "message": "this model's maximum context length is %d tokens; the "
                               "request is about %d" % (MODEL_CONTEXT_TOKENS, estimate),
                    "type": "invalid_request_error",
                    "code": "context_length_exceeded",
                }
            }

    # Outside the lock: this is the call that goes over the network.
    text, mode, cache, provider_tokens, note = _ask_model(seq, messages, max_tokens)

    with _lock:
        record["mode"] = mode
        record["cache"] = cache
        record["note"] = note
        record["provider_prompt_tokens"] = provider_tokens
        record["outcome"] = "answered" if text else "upstream_error"

    if not text:
        return 502, {"error": {"message": "the gateway did not answer: %s" % note,
                               "type": "server_error"}}

    return 200, {
        "id": "chatcmpl-%s-%d" % (record["turn_id"], seq),
        "object": "chat.completion",
        "model": payload.get("model") or LLM_MODEL,
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}],
        "usage": {
            "prompt_tokens": provider_tokens if provider_tokens is not None else 0,
            "completion_tokens": _tokens(text),
            "estimated_prompt_tokens": record["prompt_tokens_estimated"],
        },
    }


def by_turn():
    """One row per turn: the calls made for it and the worst of each measure."""
    rows = {}
    for call in _state["calls"]:
        row = rows.setdefault(call["turn_id"], {
            "turn_id": call["turn_id"], "calls": 0, "messages": 0,
            "prompt_tokens_estimated": 0, "pinned_missing": [],
            "turns_present": 0, "outcome": "",
        })
        row["calls"] += 1
        row["messages"] = call["messages"]
        row["prompt_tokens_estimated"] = max(
            row["prompt_tokens_estimated"], call["prompt_tokens_estimated"])
        for pid in call["pinned_missing"]:
            if pid not in row["pinned_missing"]:
                row["pinned_missing"].append(pid)
        row["turns_present"] = len(call["turns_present"])
        row["outcome"] = call["outcome"]
    return rows


def snapshot(include_shape=None):
    with _lock:
        calls = list(_state["calls"])
        estimates = [c["prompt_tokens_estimated"] for c in calls] or [0]
        case = _load_case()
        out = {
            "totals": {
                "calls": len(calls),
                "biggest_prompt_tokens": max(estimates),
                "prompt_budget_tokens": PROMPT_BUDGET_TOKENS,
                "context_window_tokens": MODEL_CONTEXT_TOKENS,
                "over_budget_calls": sum(1 for c in calls if c["over_budget"]),
                "refused_calls": sum(1 for c in calls
                                     if c["outcome"] == "refused_context_length"),
                "calls_missing_pinned": sum(1 for c in calls if c["pinned_missing"]),
                "pinned_ids": [p["id"] for p in case["pinned"]],
                "mode": MODEL_MODE,
                "model": LLM_MODEL or "(none configured)",
            },
            "calls": calls,
            "by_turn": sorted(by_turn().values(), key=lambda r: r["turn_id"]),
        }
        if include_shape is not None:
            out["shape"] = _state["shapes"].get(include_shape, [])
        return out


def reset():
    with _lock:
        _state["calls"] = []
        _state["shapes"] = {}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Context</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 h2{font-size:.95rem;margin:2rem 0 .5rem;color:#444}
 p.sub{color:#666;margin:0 0 1.5rem}
 #summary{font-size:1rem;margin:0 0 1.5rem;padding:.6rem .8rem;border-left:3px solid #999;background:#fafafa}
 #summary.bad{border-left-color:#c00;background:#fff4f4}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 td.n{text-align:right;font-variant-numeric:tabular-nums}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 th.n{text-align:right}
 code{font:12px/1.4 ui-monospace,Menlo,monospace}
 tr.hot td{background:#fff4f4}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .tag.warn{background:#a60}
 .ok{color:#396}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  tr.hot td{background:#3a1c1c} th{color:#999} .ok{color:#6c9}
 }
</style></head><body>
<h1>Context</h1>
<p class="sub">What the desk put in each request to the model. Refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<h2>Calls</h2>
<table><thead><tr><th>#</th><th>Turn</th><th class="n">Messages</th><th class="n">Tokens (est)</th>
<th class="n">Tokens (gateway)</th><th>Rules &amp; constraints</th><th class="n">Turns in</th>
<th>Outcome</th><th>Source</th><th>At</th></tr></thead>
<tbody id="rows"></tbody></table>
<h2>The last request, message by message</h2>
<table><thead><tr><th class="n">#</th><th>Role</th><th class="n">Tokens</th><th>Starts with</th></tr></thead>
<tbody id="shape"></tbody></table>
<script>
const base = location.pathname.replace(/\\/+$/, "");
const n = x => (x === null || x === undefined) ? "\\u2014" : x.toLocaleString();
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/calls")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the context service"; return; }
  const t = data.totals || {}, calls = data.calls || [], shape = data.shape || [];
  const all = (t.pinned_ids || []).length;
  const bad = t.calls_missing_pinned || 0;
  const s = document.getElementById("summary");
  s.className = (bad || t.over_budget_calls || t.refused_calls) ? "bad" : "";
  const first = calls.find(c => c.pinned_missing.length);
  s.textContent =
    (t.calls || 0) + " call(s) recorded. " +
    (bad ? bad + " of them went out with some of the " + all + " rules and constraints missing" +
           (first ? ", first at call " + first.seq + " (" + first.turn_id + "), which was missing " +
             first.pinned_missing.join(", ") : "") + ". "
         : "Every call carried all " + all + " rules and constraints. ") +
    "The biggest request was " + n(t.biggest_prompt_tokens) + " tokens against a prompt budget of " +
    n(t.prompt_budget_tokens) + " and a context window of " + n(t.context_window_tokens) + "; " +
    (t.over_budget_calls || 0) + " call(s) were over the budget and " + (t.refused_calls || 0) +
    " were refused for being over the window.";
  document.getElementById("rows").innerHTML = calls.map(c => {
    const hot = c.pinned_missing.length || c.over_budget || c.outcome !== "answered";
    return `<tr class="${hot ? "hot" : ""}"><td>${c.seq}</td><td>${c.turn_id}</td>` +
      `<td class="n">${n(c.messages)}</td>` +
      `<td class="n">${n(c.prompt_tokens_estimated)}` +
      (c.over_budget ? ' <span class="tag warn">over budget</span>' : "") + `</td>` +
      `<td class="n">${n(c.provider_prompt_tokens)}</td>` +
      `<td>` + (c.pinned_missing.length
        ? '<span class="tag">missing</span> ' + c.pinned_missing.join(", ")
        : '<span class="ok">all ' + c.pinned_present.length + " present</span>") + `</td>` +
      `<td class="n">${n(c.turns_present.length)}</td>` +
      `<td><code>${c.outcome}</code>${c.note ? " " + c.note : ""}</td>` +
      `<td><code>${c.mode}</code>${c.cache && c.cache !== "-" ? " " + c.cache : ""}</td>` +
      `<td>${c.at}</td></tr>`;
  }).join("") || '<tr><td colspan="10" class="empty">no calls yet</td></tr>';
  document.getElementById("shape").innerHTML = shape.map((m, i) =>
    `<tr><td class="n">${i + 1}</td><td><code>${m.role}</code></td>` +
    `<td class="n">${n(m.tokens)}</td><td>${m.head.replace(/</g, "&lt;")}</td></tr>`
  ).join("") || '<tr><td colspan="4" class="empty">nothing sent yet</td></tr>';
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8794/api/log and behind the session proxy at
    /sessions/<id>/services/context/api/log."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-context/1.0"

    def log_message(self, fmt, *args):  # one line per request, on stdout
        print("context %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = _route(self.path)
        if route == "/healthz":
            return self._send(200, {"ok": True, "service": "context"})
        if route == "/api/log":
            return self._send(200, snapshot())
        if route == "/api/calls":
            # Same numbers, last 20 calls and the newest request's shape, for
            # the page that polls it.
            with _lock:
                newest = len(_state["calls"])
            data = snapshot(include_shape=newest)
            data["calls"] = data["calls"][-20:]
            return self._send(200, data)
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route != "/v1/chat/completions":
            return self._send(404, {"error": {"message": "no such endpoint: %s" % self.path}})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        text = raw.decode("utf-8", "replace")
        try:
            payload = json.loads(text)
        except ValueError:
            return self._send(400, {"error": {"message": "body must be JSON"}})

        status, body = complete(text, payload)
        try:
            self._send(status, body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller gave up waiting and closed the socket. The request is
            # recorded either way -- that is the point of this service -- and
            # letting the traceback print would put a red herring in the log
            # of a lab about reading the record rather than the agent.
            pass


def main():
    case = _load_case()
    print(
        "context service listening on :%d (window %d, prompt budget %d, %d pinned item(s) "
        "from %s, mode %s, model %s, upstream %s)"
        % (PORT, MODEL_CONTEXT_TOKENS, PROMPT_BUDGET_TOKENS, len(case["pinned"]),
           os.path.basename(CASE_FILE), MODEL_MODE, LLM_MODEL or "-",
           LLM_BASE_URL or "(none configured; replies come from the local table)"),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
