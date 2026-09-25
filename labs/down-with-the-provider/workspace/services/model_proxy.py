#!/usr/bin/env python3
"""The desk's model provider, as seen from inside this container.

This is a proxy, not a stub. It speaks the OpenAI chat-completions shape on
``POST /chat/completions`` and, for a call it does not interfere with, it
forwards that call to the **real** model provider the session was given in
``LLM_BASE_URL`` and hands back exactly what came out of it. The container
holds no credential of its own: one is injected outside it, on the way out,
so a plain HTTPS call from here reaches the provider and nothing else does.

Which is why this file exists at all. A real provider cannot be asked to
have an outage on a schedule, so the outage is injected here, in front of it:

  * ``PROVIDER_OUTAGE_ITEMS``  -- the provider is not asked at all. Every
    call for one of these requests comes back 503. This is the outage.
  * ``PROVIDER_HANG_ITEMS``    -- the first call for one of these is left
    hanging for ``PROVIDER_HANG_SECONDS`` and then answered into a socket
    the caller has almost certainly stopped listening to. Later calls are
    refused quickly, so a retry policy is not punished with another wait.
  * ``PROVIDER_DROP_CHOICES_ITEMS`` and ``PROVIDER_PARTS_CONTENT_ITEMS`` --
    the call *is* forwarded, the provider *does* answer, and then the
    envelope is changed on the way back: ``choices`` removed in the first
    case, ``content`` boxed into a list of parts in the second. Both come
    back as HTTP 200. This is what a provider looks like the week after an
    incident, when the pool that answers you is not the pool that answered
    you yesterday.

Every one of those is keyed to a request id and to how many calls that id
has had since the last reset. Nothing here is random and nothing here looks
at the clock to decide anything.

What is *not* deterministic is what the provider says. It is a real model:
the same prompt is not the same bytes twice, and no temperature setting
changes that. So nothing in this lab is graded on the provider's wording.
What is graded is what the desk did with it -- which is why this service
records the text it served, in full, on ``/api/log``: the answer the desk
filed can then be checked against the answer the provider actually gave,
without anybody having to predict either.

Two practical notes:

* **Cache.** Each forwarded call carries ``cf-aig-cache-key`` derived from
  the request id and ``cf-aig-cache-ttl``, so a second pass over the same
  queue is cheap and fast. The gateway's cache status is recorded per call
  and is *information*, never a condition: the explicit-key path is
  measured to need two sequential repeats before it reports HIT, so a MISS
  is a normal thing to see and never a failure.

* **Replay.** With no ``LLM_BASE_URL`` in the environment -- outside a
  session, on an author's machine -- the proxy serves canned completions
  instead of forwarding, and says so on every line it logs and in its own
  UI. The faults, the records and the graders behave identically; only the
  words are local. It is a testing mode, not a lab mode.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("PROVIDER_PORT", "8861"))

# Where the real provider is, and which model it should serve. Both come from
# the session, not from the manifest: LLM_BASE_URL is the OpenAI-compatible
# endpoint the platform points every lab at, and LLM_MODEL is the model it
# sanctioned. The model on the way out is the session's, not the caller's, so
# that a session pointed at a different model keeps working without anybody
# editing a lab.
UPSTREAM_BASE = os.environ.get("LLM_BASE_URL", "").rstrip("/")
UPSTREAM_MODEL = os.environ.get("LLM_MODEL", "")
UPSTREAM_TIMEOUT_S = float(os.environ.get("PROVIDER_UPSTREAM_TIMEOUT_S", "30"))
CACHE_TTL_S = int(os.environ.get("PROVIDER_CACHE_TTL_S", "86400"))
CACHE_PREFIX = os.environ.get("PROVIDER_CACHE_PREFIX", "opalix-front-desk")

# auto: forward if there is somewhere to forward to. replay: never forward.
MODE = os.environ.get("PROVIDER_MODE", "auto").strip().lower()
REPLAYING = MODE == "replay" or not UPSTREAM_BASE

OUTAGE = [i for i in os.environ.get("PROVIDER_OUTAGE_ITEMS", "").split(",") if i]
HANG = [i for i in os.environ.get("PROVIDER_HANG_ITEMS", "").split(",") if i]
HANG_SECONDS = float(os.environ.get("PROVIDER_HANG_SECONDS", "14"))
DROP_CHOICES = [i for i in os.environ.get("PROVIDER_DROP_CHOICES_ITEMS", "").split(",") if i]
PARTS_CONTENT = [i for i in os.environ.get("PROVIDER_PARTS_CONTENT_ITEMS", "").split(",") if i]

ROUTES = ("/chat/completions", "/api/calls", "/api/log", "/api/reset", "/healthz")

# The outcome vocabulary, and the harness's single source of truth for which
# calls were interfered with. Each name is the whole story of one call.
SERVED = "served"
REFUSED = "refused_by_outage"
HUNG = "hung_then_gave_up"
DAMAGED_CHOICES = "served_then_choices_removed"
DAMAGED_CONTENT = "served_then_content_boxed"
UPSTREAM_ERROR = "upstream_error"
UPSTREAM_UNREACHABLE = "upstream_unreachable"

_lock = threading.Lock()
_state = {
    "calls": [],      # every call this service handled, in order
    "attempts": {},   # item_id -> calls handled for it since the last reset
}


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8861/api/log and behind the session proxy at
    /sessions/<id>/services/provider/api/log."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _item_id(raw_body, prompt):
    """Finds which request a call is about.

    Deliberately not tied to the call's layout. Which requests fail, hang or
    come back misshapen is keyed to the request id, and the labelled
    ``Request:`` line only exists because agent/provider.py happens to write
    one today. A learner who rewrites the prompt builder is not making the
    bug worse and must not silently turn the faults off and then be told
    their fix does not degrade. So: match the id anywhere in the whole
    request body first, and fall back to a labelled line.
    """
    match = re.search(r"\bREQ-\d{4}\b", raw_body)
    if match:
        return match.group(0)
    match = re.search(r"^Request(?: ID)?:[ \t]*(\S+)", prompt, re.MULTILINE)
    return match.group(1).strip() if match else "unknown"


def _prompt_of(payload):
    messages = payload.get("messages") or []
    return "\n".join(str(m.get("content", "")) for m in messages)


def _record(item_id, attempt, outcome, **extra):
    """Appends one call to the record. Called with the lock held."""
    row = {
        "seq": len(_state["calls"]) + 1,
        "item_id": item_id,
        "attempt": attempt,
        "outcome": outcome,
        "upstream_status": extra.get("upstream_status"),
        "cache": extra.get("cache"),
        "model": extra.get("model"),
        "damaged_field": extra.get("damaged_field"),
        "served_text": extra.get("served_text") or "",
        "duration_ms": extra.get("duration_ms"),
        "replayed": bool(REPLAYING),
        "at": _now(),
    }
    _state["calls"].append(row)
    return row


# --- talking to the real provider -------------------------------------------


def _forward(item_id, payload):
    """Forwards one call and returns (status, body, cache_status, ms).

    No credential is set here and none is available here: the call goes out
    over HTTPS and something outside this container adds one. That is the
    whole reason a lab can make a real model call without holding a key.
    """
    body = dict(payload)
    if UPSTREAM_MODEL:
        body["model"] = UPSTREAM_MODEL
    raw = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        UPSTREAM_BASE + "/chat/completions", data=raw, method="POST"
    )
    request.add_header("Content-Type", "application/json")
    # Keyed to the request id, not to a hash of the body: a learner who
    # rewords the prompt should still get a cheap, fast second pass, and
    # nothing here is graded on what came back anyway.
    request.add_header("cf-aig-cache-key", "%s-%s" % (CACHE_PREFIX, item_id))
    request.add_header("cf-aig-cache-ttl", str(CACHE_TTL_S))

    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
            text = response.read().decode("utf-8", "replace")
            cache = response.headers.get("cf-aig-cache-status")
            status = response.status
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")[:2000]
        cache = err.headers.get("cf-aig-cache-status") if err.headers else None
        status = err.code
    except Exception as err:  # noqa: BLE001 - every way of not reaching it is one story
        ms = int((time.time() - started) * 1000)
        print(
            "provider: could not reach %s: %s" % (UPSTREAM_BASE, err),
            flush=True,
        )
        return None, {"error": {"message": "could not reach the model provider: %s" % err,
                                "type": "upstream_unreachable"}}, None, ms

    ms = int((time.time() - started) * 1000)
    try:
        parsed = json.loads(text)
    except ValueError:
        return status, {"error": {"message": "the provider did not return JSON",
                                 "type": "upstream_error", "body": text[:400]}}, cache, ms
    return status, parsed, cache, ms


# Replay mode only. A real provider does not return the same bytes twice, so
# neither does this: the canned dispositions rotate per call and are of
# deliberately different lengths and wordings. Nothing is graded on them --
# they exist so the faults, the records and the graders can be exercised with
# no provider at hand.
REPLAY_LINES = [
    "Route this to Billing. The account has two seat licences on the October "
    "invoice and only one active seat, so the second line is almost certainly a "
    "proration that was not reversed; Billing can confirm from the subscription "
    "history and reissue.",
    "Route this to Support with the data-export runbook attached. The quarterly "
    "usage export is self-service from the workspace settings page, and the only "
    "reason to run it for them is if their plan predates the per-workspace "
    "breakdown.",
    "Route this to Access, urgently. A sign-in that spins and then says nothing "
    "for several people on one account reads as an account-level lock rather "
    "than three forgotten passwords, and there is a call at two.",
    "Route this to Platform. Exactly two deliveries a second apart is a retry, "
    "not a duplicate publish, so the question is whether our receiver is "
    "acknowledging late; ask for one delivery id before escalating further.",
    "Route this to Support and then to Data. Restores go back thirty days, and "
    "starting one needs the workspace id and written confirmation from an admin "
    "who is not the person who deleted it.",
]


_replayed = [0]


def _replay(item_id, payload, nth):
    """A canned completion in the real envelope's shape.

    Rotated on a counter over the whole run rather than per request, so that
    two requests do not get identical bytes -- a replay that is more
    deterministic than the provider it stands in for would let something pass
    here that the provider would break.
    """
    with _lock:
        _replayed[0] += 1
        index = _replayed[0]
    line = REPLAY_LINES[(index - 1) % len(REPLAY_LINES)]
    text = "%s (replayed locally, call %d, for %s)" % (line, index, item_id)
    return 200, {
        "id": "chatcmpl-replay-%s-%d" % (item_id, nth),
        "object": "chat.completion",
        "created": 0,
        "model": payload.get("model") or UPSTREAM_MODEL or "replay",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": text},
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }, "REPLAY", 0


# --- the faults -------------------------------------------------------------


def _served_text(body):
    """The completion text out of a well-formed reply, or ''."""
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""
    return content if isinstance(content, str) else ""


def _strip_choices(body):
    """The reply, minus the one key everything downstream reads.

    Not invented: a provider that fails over to a pool speaking a different
    dialect returns a body that is a perfectly good 200 with the answer
    somewhere else, or nowhere. Usage and ids survive, which is what makes it
    look like a success to anything that only checks the status line.
    """
    out = {k: v for k, v in body.items() if k != "choices"}
    out["output_text"] = _served_text(body)
    return out


def _box_content(body):
    """The reply, with ``content`` as a list of parts instead of a string.

    Also not invented: the parts-list form is what several providers return
    today, and a consumer written against the string form reads the list as
    truthy, prints it, or calls a string method on it and stops.
    """
    out = json.loads(json.dumps(body))
    try:
        message = out["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return out
    message["content"] = [{"type": "text", "text": _served_text(body)}]
    return out


def handle(raw_body, payload):
    """Handles one call. Returns (status, body, sleep_seconds_before_sending).

    The sleep is returned rather than taken here so that the record is
    written before the waiting starts: a call this service decided to leave
    hanging is a call it received, and the record has to say so even though
    the caller will never hear the answer.
    """
    prompt = _prompt_of(payload)
    item_id = _item_id(raw_body, prompt)

    with _lock:
        nth = _state["attempts"].get(item_id, 0) + 1
        _state["attempts"][item_id] = nth

        if item_id in OUTAGE:
            _record(item_id, nth, REFUSED)
            return 503, {
                "error": {
                    "message": "the model provider is unavailable for this request",
                    "type": "server_error",
                }
            }, 0.0

        # First call only: later attempts are refused quickly, so a bounded
        # retry policy is not made to sit through the wait more than once.
        if item_id in HANG and nth == 1:
            _record(item_id, nth, HUNG, duration_ms=int(HANG_SECONDS * 1000))
            return 504, {
                "error": {
                    "message": "no answer from the model provider in time",
                    "type": "timeout",
                }
            }, HANG_SECONDS
        if item_id in HANG:
            _record(item_id, nth, REFUSED)
            return 503, {
                "error": {
                    "message": "the model provider is unavailable for this request",
                    "type": "server_error",
                }
            }, 0.0

    # Nothing above asked the provider anything. Everything below does, so it
    # happens outside the lock -- a real call takes seconds and two requests
    # for different items must not queue behind each other.
    if REPLAYING:
        status, body, cache, ms = _replay(item_id, payload, nth)
    else:
        status, body, cache, ms = _forward(item_id, payload)

    if status is None:
        with _lock:
            _record(item_id, nth, UPSTREAM_UNREACHABLE, cache=cache, duration_ms=ms)
        return 502, body, 0.0
    if status < 200 or status >= 300:
        with _lock:
            _record(item_id, nth, UPSTREAM_ERROR, upstream_status=status,
                    cache=cache, duration_ms=ms)
        return status, body, 0.0

    # The provider has now answered, and what it said is recorded in full
    # before anything is done to it. Everything below decides only what the
    # caller gets to read.
    text = _served_text(body)
    model = body.get("model")

    if item_id in DROP_CHOICES:
        with _lock:
            _record(item_id, nth, DAMAGED_CHOICES, upstream_status=status, cache=cache,
                    model=model, damaged_field="choices", served_text=text, duration_ms=ms)
        return 200, _strip_choices(body), 0.0

    if item_id in PARTS_CONTENT:
        with _lock:
            _record(item_id, nth, DAMAGED_CONTENT, upstream_status=status, cache=cache,
                    model=model, damaged_field="content", served_text=text, duration_ms=ms)
        return 200, _box_content(body), 0.0

    with _lock:
        _record(item_id, nth, SERVED, upstream_status=status, cache=cache,
                model=model, served_text=text, duration_ms=ms)
    return 200, body, 0.0


# --- the record -------------------------------------------------------------


def by_item():
    """One row per request: calls, what happened to them. Lock held."""
    rows = {}
    for call in _state["calls"]:
        row = rows.setdefault(
            call["item_id"],
            {
                "item_id": call["item_id"],
                "calls": 0,
                "answered": 0,
                "refused": 0,
                "hung": 0,
                "damaged": 0,
                "damaged_fields": [],
                "upstream_errors": 0,
                "outcomes": [],
            },
        )
        row["calls"] += 1
        row["outcomes"].append(call["outcome"])
        if call["outcome"] == SERVED:
            row["answered"] += 1
        elif call["outcome"] == REFUSED:
            row["refused"] += 1
        elif call["outcome"] == HUNG:
            row["hung"] += 1
        elif call["outcome"] in (DAMAGED_CHOICES, DAMAGED_CONTENT):
            row["damaged"] += 1
            if call["damaged_field"] and call["damaged_field"] not in row["damaged_fields"]:
                row["damaged_fields"].append(call["damaged_field"])
        elif call["outcome"] in (UPSTREAM_ERROR, UPSTREAM_UNREACHABLE):
            row["upstream_errors"] += 1
    return rows


def snapshot(full=True):
    with _lock:
        calls = list(_state["calls"])
        rows = sorted(by_item().values(), key=lambda r: r["item_id"])
        totals = {
            "calls": len(calls),
            "items": len(rows),
            "answered": sum(r["answered"] for r in rows),
            "refused": sum(r["refused"] for r in rows),
            "hung": sum(r["hung"] for r in rows),
            "damaged": sum(r["damaged"] for r in rows),
            "upstream_errors": sum(r["upstream_errors"] for r in rows),
            "mode": "replay" if REPLAYING else "live",
            "upstream": UPSTREAM_BASE or "(none -- replaying locally)",
            "model": UPSTREAM_MODEL or "(none)",
        }
        if not full:
            calls = [dict(c, served_text=(c["served_text"] or "")[:160]) for c in calls[-20:]]
        return {"totals": totals, "by_item": rows, "calls": calls}


def reset():
    with _lock:
        _state["calls"] = []
        _state["attempts"] = {}
        _replayed[0] = 0


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Provider</title>
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
 td.said{max-width:34rem;color:#444}
 tr.bad td{background:#fff4f4}
 tr.warn td{background:#fff9ec}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .tag.warn{background:#a60}
 .tag.ok{background:#276}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  td.said{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  tr.bad td{background:#3a1c1c} tr.warn td{background:#332c17} th{color:#999}
 }
</style></head><body>
<h1>Provider</h1>
<p class="sub">Every model call this desk made, and what came back. Refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<h2>By request</h2>
<table><thead><tr><th>Request</th><th class="n">Calls</th><th class="n">Answered</th>
<th class="n">Refused</th><th class="n">Left hanging</th><th class="n">200, wrong shape</th><th>What was changed</th></tr></thead>
<tbody id="rows"></tbody></table>
<h2>Last 20 calls</h2>
<table><thead><tr><th>#</th><th>Request</th><th class="n">Call</th><th>Outcome</th>
<th class="n">Upstream</th><th>Cache</th><th class="n">ms</th><th>What the provider actually said</th><th>At</th></tr></thead>
<tbody id="calls"></tbody></table>
<script>
const base = location.pathname.replace(/\\/+$/, "");
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/calls")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the provider proxy"; return; }
  const t = data.totals || {}, rows = data.by_item || [], calls = data.calls || [];
  const dead = rows.filter(r => r.answered === 0 && (r.refused || r.hung));
  const bent = rows.filter(r => r.damaged > 0);
  const s = document.getElementById("summary");
  s.className = (dead.length || bent.length) ? "bad" : "";
  s.textContent =
    (t.calls || 0) + " call(s) for " + (t.items || 0) + " request(s); the provider answered " +
    (t.answered || 0) + ". " +
    (dead.length ? dead.length + " request(s) never got an answer at all (" +
       dead.map(r => r.item_id + (r.hung ? ", left hanging" : ", refused " + r.refused + "x")).join("; ") + "). " : "") +
    (bent.length ? bent.length + " answer(s) came back as HTTP 200 with a body the desk cannot read (" +
       bent.map(r => r.item_id + ": " + r.damaged_fields.join(", ")).join("; ") + "). " : "") +
    (t.mode === "replay" ? "Replaying locally: no provider was contacted." :
       "Talking to " + t.upstream + " as " + t.model + ".");
  document.getElementById("rows").innerHTML = rows.map(r => {
    const cls = r.damaged > 0 ? "bad" : (r.answered === 0 ? "warn" : "");
    return `<tr class="${cls}"><td>${esc(r.item_id)}` +
      (r.answered === 0 && (r.refused || r.hung) ? ' <span class="tag warn">no answer</span>' : "") +
      (r.damaged > 0 ? ' <span class="tag">wrong shape</span>' : "") +
      (r.answered > 0 && r.damaged === 0 ? ' <span class="tag ok">ok</span>' : "") +
      `</td><td class="n">${r.calls}</td><td class="n">${r.answered || ""}</td>` +
      `<td class="n">${r.refused || ""}</td><td class="n">${r.hung || ""}</td>` +
      `<td class="n">${r.damaged || ""}</td><td><code>${esc(r.damaged_fields.join(", "))}</code></td></tr>`;
  }).join("") || '<tr><td colspan="7" class="empty">no calls yet</td></tr>';
  document.getElementById("calls").innerHTML = calls.slice().reverse().map(c =>
    `<tr><td>${c.seq}</td><td>${esc(c.item_id)}</td><td class="n">${c.attempt}</td>` +
    `<td><code>${esc(c.outcome)}</code></td><td class="n">${c.upstream_status == null ? "\\u2014" : c.upstream_status}</td>` +
    `<td>${esc(c.cache || "\\u2014")}</td><td class="n">${c.duration_ms == null ? "\\u2014" : c.duration_ms}</td>` +
    `<td class="said">${esc(c.served_text) || "\\u2014"}</td><td>${esc(c.at)}</td></tr>`).join("");
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-provider/1.0"

    def log_message(self, fmt, *args):  # one line per request, on stdout
        print("provider %s - %s" % (self.address_string(), fmt % args), flush=True)

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
            return self._send(200, {"ok": True, "service": "provider"})
        if route == "/api/log":
            return self._send(200, snapshot(full=True))
        if route == "/api/calls":
            return self._send(200, snapshot(full=False))
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route != "/chat/completions":
            return self._send(404, {"error": {"message": "no such endpoint: %s" % self.path}})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        text = raw.decode("utf-8", "replace")
        try:
            payload = json.loads(text)
        except ValueError:
            return self._send(400, {"error": {"message": "body must be JSON"}})
        if not isinstance(payload, dict):
            return self._send(400, {"error": {"message": "body must be a JSON object"}})

        status, body, delay = handle(text, payload)
        if delay:
            time.sleep(delay)
        try:
            self._send(status, body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller gave up waiting and closed the socket, which is the
            # entire point of the hang fault. The call is already recorded --
            # letting the traceback print would put a red herring in the log
            # of a lab about what the other side actually did.
            pass


def main():
    print(
        "provider listening on :%d (%s; outage %s, hang %s for %.1fs, no-choices %s, "
        "boxed-content %s)"
        % (
            PORT,
            "replaying locally, no provider contacted" if REPLAYING
            else "forwarding to %s as %s" % (UPSTREAM_BASE, UPSTREAM_MODEL or "(model from caller)"),
            ",".join(OUTAGE) or "-", ",".join(HANG) or "-", HANG_SECONDS,
            ",".join(DROP_CHOICES) or "-", ",".join(PARTS_CONTENT) or "-",
        ),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
