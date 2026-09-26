#!/usr/bin/env python3
"""The ledger in front of the real model -- and the only trustworthy record
of who actually got served.

Every request the relay decides to admit ends up here, and only here: a
request the relay refuses for budget never reaches this service at all. It
writes down which tenant the call was for, what it would cost, and then
forwards it to the real model behind the session's AI Gateway. It does not
take the relay's word for whose call this is -- it reads the tenant id out
of the request body itself, the same as the relay was supposed to -- so a
relay that mis-attributes or fudges a call cannot also make the ledger agree
with it.

Four things worth knowing:

1. Tenant attribution is by the tenant's own id, found anywhere the body
   still carries it -- a top-level field first, then anywhere in the raw
   text. It does not depend on any particular field name or body shape, so
   restructuring the request (nesting the id differently, renaming a field)
   does not change who a call is charged to.

2. It computes a call's cost itself, from the message content and the
   requested completion cap, the same formula the relay uses. That number
   is what the graders check the relay's admissions against -- it is a
   property of the request that reached this service, not a number the
   relay reported about itself.

3. It holds no credential and needs none. $LLM_BASE_URL is the session's
   OpenAI-compatible endpoint; the Worker in front of it injects the token.

4. If the gateway cannot be reached at all, MODEL_MODE=auto falls back to a
   fixed local reply and records the reason. Nothing here is graded on the
   reply, so the fallback cannot move a verdict either. Requests go out with
   an explicit cf-aig-cache-key, and the explicit-key path needs two
   sequential repeats before it reports HIT -- an early MISS is normal.

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

PORT = int(os.environ.get("UPSTREAM_PORT", "8933"))

TRAFFIC_FILE = os.environ.get("TRAFFIC_FILE", "/workspace/traffic.json")
TENANT_BUDGET_TOKENS = int(os.environ.get("TENANT_BUDGET_TOKENS", "1500"))

LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "")

MODEL_MODE = os.environ.get("MODEL_MODE", "auto").strip().lower()
UPSTREAM_ATTEMPTS = int(os.environ.get("UPSTREAM_ATTEMPTS", "2"))
UPSTREAM_TIMEOUT_S = float(os.environ.get("UPSTREAM_TIMEOUT_S", "45"))
CACHE_TTL_S = int(os.environ.get("MODEL_CACHE_TTL_S", "86400"))

PER_MESSAGE_OVERHEAD = 4

ROUTES = ("/v1/chat/completions", "/api/log", "/api/reset", "/healthz")

_lock = threading.Lock()
_state = {"calls": []}  # one record per admitted request, in order

_traffic_lock = threading.Lock()
_traffic = {"mtime": None, "tenants": [], "totals": {}}


# --- counting, the same way the relay counts --------------------------------


def _tok(text):
    return max(1, (len(text) + 3) // 4)


def _prompt_tokens(messages):
    return sum(_tok(str(m.get("content") or "")) + PER_MESSAGE_OVERHEAD for m in messages)


# --- which tenant a call belongs to -----------------------------------------


def _load_traffic():
    """The known tenant ids and each one's total workload, reloaded when the
    traffic file changes -- a pressure event can add more requests mid-run."""
    try:
        mtime = os.path.getmtime(TRAFFIC_FILE)
    except OSError:
        return _traffic
    with _traffic_lock:
        if _traffic["mtime"] == mtime:
            return _traffic
        try:
            with open(TRAFFIC_FILE, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return _traffic
        requests = data.get("requests") or []
        tenants = sorted(set(r["tenant"] for r in requests))
        totals = {}
        for tenant in tenants:
            items = [r for r in requests if r["tenant"] == tenant]
            cost = sum(_tok(r["text"]) + PER_MESSAGE_OVERHEAD + 120 for r in items)
            totals[tenant] = {"requests": len(items), "workload_tokens": cost}
        _traffic.update({"mtime": mtime, "tenants": tenants, "totals": totals})
        return _traffic


def _tenant_id(raw_body, payload):
    """Finds which tenant a call belongs to, without trusting any one field
    or shape. A known tenant id anywhere in the raw body is the reliable
    signal -- it survives a field being renamed or nested differently. A
    declared field is the fallback, for a tenant id this run has never seen
    before (a learner testing against a traffic file of their own)."""
    known = _load_traffic()["tenants"]
    for tenant in known:
        if re.search(r"\b" + re.escape(tenant) + r"\b", raw_body):
            return tenant
    for source in (payload.get("metadata") if isinstance(payload.get("metadata"), dict)
                   else {}, payload):
        value = source.get("tenant") if isinstance(source, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "unknown"


# --- the local reply table --------------------------------------------------

REPLAY = [
    "Classified as: delay. The driver is describing a queue at the port, not a "
    "mechanical fault or a paperwork hold, so it belongs on the delay board.",
    "Referral rewritten: presenting complaint and history carried over as given, "
    "current medication listed as stated, and the referring question kept as the "
    "final line rather than folded into the history.",
    "Tidied title: capitalised, boilerplate and asterisks removed, kept under the "
    "length limit.",
    "The rejections cluster on two suppliers; the attribute-set mismatches point at "
    "the same feed that failed Thursday, and that is the one to escalate first.",
]


def _replay_reply(seq):
    return REPLAY[(seq - 1) % len(REPLAY)]


# --- upstream ----------------------------------------------------------------


def _cache_key(model, messages, max_tokens):
    canonical = json.dumps(
        {"model": model, "max_tokens": max_tokens,
         "messages": [{"role": m.get("role"), "content": m.get("content")} for m in messages]},
        sort_keys=True, separators=(",", ":"),
    )
    return "locked-out-in-credit-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:40]


def _forward(messages, max_tokens):
    model = LLM_MODEL or "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8"
    body = json.dumps({
        "model": model,
        "messages": [{"role": m.get("role", "user"), "content": str(m.get("content") or "")}
                     for m in messages],
        "temperature": 0,
        "max_tokens": max_tokens,
    }).encode("utf-8")

    request = urllib.request.Request(LLM_BASE_URL + "/chat/completions", data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("cf-aig-cache-key", _cache_key(model, messages, max_tokens))
    request.add_header("cf-aig-cache-ttl", str(CACHE_TTL_S))

    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
        payload = json.loads(response.read().decode("utf-8"))
        cache = response.headers.get("cf-aig-cache-status") or "-"
    text = ((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return text, cache


def _ask_model(seq, messages, max_tokens):
    """Returns (text, mode, cache, note)."""
    if MODEL_MODE == "replay" or not LLM_BASE_URL:
        why = "MODEL_MODE=replay" if MODEL_MODE == "replay" else "no LLM_BASE_URL in the environment"
        return _replay_reply(seq), "replay", "-", why

    last = ""
    for attempt in range(1, UPSTREAM_ATTEMPTS + 1):
        try:
            text, cache = _forward(messages, max_tokens)
            if text.strip():
                return text, "live", cache, ""
            last = "the gateway returned an empty reply"
        except urllib.error.HTTPError as err:
            last = "HTTP %d from the gateway" % err.code
        except Exception as err:  # noqa: BLE001 - every transport failure is one story
            last = "%s: %s" % (type(err).__name__, err)
        if attempt < UPSTREAM_ATTEMPTS:
            time.sleep(0.5 * attempt)

    if MODEL_MODE == "live":
        return None, "live", "-", last
    return _replay_reply(seq), "replay", "-", last


# --- the record --------------------------------------------------------------


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def complete(raw_body, payload):
    messages = payload.get("messages") or []
    max_tokens = int(payload.get("max_tokens") or 120)
    tenant = _tenant_id(raw_body, payload)
    estimate = _prompt_tokens(messages)
    cost = estimate + max_tokens

    with _lock:
        seq = len(_state["calls"]) + 1
        record = {
            "seq": seq,
            "tenant": tenant,
            "request_id": ((payload.get("metadata") or {}).get("request_id")
                           if isinstance(payload.get("metadata"), dict) else None) or "-",
            "prompt_tokens_estimated": estimate,
            "requested_max_tokens": max_tokens,
            "cost_estimated": cost,
            "outcome": "pending",
            "mode": "-",
            "note": "",
            "at": _now(),
        }
        _state["calls"].append(record)

    if not messages:
        with _lock:
            record["outcome"] = "rejected_empty"
        return 400, {"error": {"message": "messages must not be empty"}}

    text, mode, cache, note = _ask_model(seq, messages, max_tokens)
    with _lock:
        record["mode"] = mode
        record["note"] = note
        record["outcome"] = "answered" if text else "upstream_error"

    if not text:
        return 502, {"error": {"message": "the gateway did not answer: %s" % note}}

    return 200, {
        "id": "chatcmpl-%s-%d" % (tenant, seq),
        "object": "chat.completion",
        "model": payload.get("model") or LLM_MODEL,
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}],
        "usage": {"estimated_prompt_tokens": estimate},
    }


def snapshot():
    with _lock:
        calls = list(_state["calls"])
    traffic = _load_traffic()
    per_tenant = {}
    running = {}
    overspend_first = None
    for call in calls:
        t = call["tenant"]
        running[t] = running.get(t, 0) + call["cost_estimated"]
        row = per_tenant.setdefault(t, {
            "tenant": t, "calls_received": 0, "cost_of_received": 0,
            "over_budget_admitted": False,
        })
        row["calls_received"] += 1
        row["cost_of_received"] = running[t]
        if running[t] > TENANT_BUDGET_TOKENS and not row["over_budget_admitted"]:
            row["over_budget_admitted"] = True
            if overspend_first is None:
                overspend_first = (t, call["seq"])

    missing = []
    for tenant in traffic["tenants"]:
        expected = traffic["totals"].get(tenant, {})
        received = per_tenant.get(tenant, {}).get("calls_received", 0)
        expected_n = expected.get("requests", 0)
        if received < expected_n and expected.get("workload_tokens", 0) <= TENANT_BUDGET_TOKENS:
            missing.append({
                "tenant": tenant, "received": received, "expected": expected_n,
                "workload_tokens": expected.get("workload_tokens", 0),
            })

    return {
        "totals": {
            "calls": len(calls),
            "tenant_budget_tokens": TENANT_BUDGET_TOKENS,
            "tenants": traffic["tenants"],
            "workloads": traffic["totals"],
            "overspend_first": overspend_first,
            "collateral": missing,
            "mode": MODEL_MODE,
            "model": LLM_MODEL or "(none configured)",
        },
        "calls": calls,
        "by_tenant": sorted(per_tenant.values(), key=lambda r: r["tenant"]),
    }


def reset():
    with _lock:
        _state["calls"] = []


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Ledger</title>
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
 .ok{color:#396}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  tr.hot td{background:#3a1c1c} th{color:#999} .ok{color:#6c9}
 }
</style></head><body>
<h1>Ledger</h1>
<p class="sub">Every call that actually reached the model, by tenant. Refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<h2>By tenant</h2>
<table><thead><tr><th>Tenant</th><th class="n">Calls received</th><th class="n">Expected</th>
<th class="n">Workload (tokens)</th><th class="n">Budget</th><th>Note</th></tr></thead>
<tbody id="tenants"></tbody></table>
<h2>Calls, in order</h2>
<table><thead><tr><th class="n">#</th><th>Tenant</th><th>Request</th><th class="n">Cost (est)</th>
<th>Outcome</th><th>Source</th><th>At</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const base = location.pathname.replace(/\\/+$/, "");
const n = x => (x === null || x === undefined) ? "\\u2014" : x.toLocaleString();
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/log")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the ledger service"; return; }
  const t = data.totals || {}, calls = data.calls || [], byTenant = data.by_tenant || [];
  const s = document.getElementById("summary");
  const collateral = t.collateral || [];
  s.className = collateral.length ? "bad" : "";
  if (collateral.length) {
    const c = collateral[0];
    s.textContent = collateral.length + " tenant(s) had calls that never reached the model even "
      + "though their own workload fits inside the budget -- worst is " + c.tenant + ": only "
      + c.received + " of " + c.expected + " arrived here, and its whole workload is "
      + n(c.workload_tokens) + " tokens against a " + n(t.tenant_budget_tokens)
      + "-token budget. Something else's spending is reaching this account.";
  } else if (t.calls) {
    s.textContent = "every tenant whose own workload fits its " + n(t.tenant_budget_tokens)
      + "-token budget had every one of its calls reach the model. "
      + (t.overspend_first ? "the first admitted call that pushed a tenant over its own budget was "
          + t.overspend_first[0] + "'s call #" + t.overspend_first[1] + "." : "no admitted call ever "
          + "pushed a tenant over its own budget.");
  } else {
    s.textContent = "no calls recorded yet.";
  }
  document.getElementById("tenants").innerHTML = byTenant.map(r => {
    const w = (t.workloads || {})[r.tenant] || {};
    const hot = r.over_budget_admitted;
    return `<tr class="${hot ? "hot" : ""}"><td>${r.tenant}</td><td class="n">${n(r.calls_received)}</td>`
      + `<td class="n">${n(w.requests)}</td><td class="n">${n(w.workload_tokens)}</td>`
      + `<td class="n">${n(t.tenant_budget_tokens)}</td>`
      + `<td>${hot ? '<span class="tag">admitted over its own budget</span>' : '<span class="ok">within budget</span>'}</td></tr>`;
  }).join("") || '<tr><td colspan="6" class="empty">no calls yet</td></tr>';
  document.getElementById("rows").innerHTML = calls.slice(-40).map(c =>
    `<tr><td class="n">${c.seq}</td><td>${c.tenant}</td><td><code>${c.request_id}</code></td>`
    + `<td class="n">${n(c.cost_estimated)}</td><td><code>${c.outcome}</code></td>`
    + `<td><code>${c.mode}</code></td><td>${c.at}</td></tr>`
  ).join("") || '<tr><td colspan="7" class="empty">nothing sent yet</td></tr>';
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-ledger/1.0"

    def log_message(self, fmt, *args):
        print("ledger %s - %s" % (self.address_string(), fmt % args), flush=True)

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
            return self._send(200, {"ok": True, "service": "upstream"})
        if route == "/api/log":
            return self._send(200, snapshot())
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
            pass


def main():
    traffic = _load_traffic()
    print("upstream listening on :%d (budget %d, %d tenant(s) from %s, mode %s, model %s)"
          % (PORT, TENANT_BUDGET_TOKENS, len(traffic["tenants"]),
             os.path.basename(TRAFFIC_FILE), MODEL_MODE, LLM_MODEL or "-"), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
