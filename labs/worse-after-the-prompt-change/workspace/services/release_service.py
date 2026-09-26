#!/usr/bin/env python3
"""The release pipeline -- the diagnostic.

This is not a smarter grader. It is a pipeline: it does one thing with a
gate's decision, which is act on it. POST it a decision -- candidate,
baseline, the scores, the margin, ship or refuse, and why -- and it either
marks the candidate deployed or blocks it and files the reason. It never
re-scores anything itself and it never calls the judge; everything it
knows about a decision is what the gate told it, which is exactly what a
real release pipeline knows.

The **release** tab is the diagnostic surface for this lab: it is where an
anomaly gets named in plain words -- a candidate shipped despite a big drop
from baseline, or nothing has shipped in twenty decisions, or the reason
field is empty. It does not know what a "correct" gate looks like; it only
narrates what has actually happened here.

Nothing on this page, and nothing this service returns, ever contains the
text of a drafted reply. That lives in the judge's own log, and it is not
this service's job to repeat it.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("RELEASE_PORT", "8902"))
ROUTES = ("/api/decisions", "/api/log", "/api/reset", "/healthz")

# A ship that looks fishy is one where the shipped score is more than this
# far below the baseline it was compared to. Purely descriptive -- this
# service does not refuse anything on its own account, it just says so.
SUSPICIOUS_DROP = 0.10

_lock = threading.Lock()
_state = {"decisions": [], "deployed": {}}


def reset():
    with _lock:
        _state["decisions"] = []
        _state["deployed"] = {}


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def record_decision(payload):
    candidate = str(payload.get("candidate") or "unknown")
    ship = bool(payload.get("ship"))
    entry = {
        "seq": 0,
        "at": _now(),
        "candidate": candidate,
        "baseline_candidate": payload.get("baseline_candidate"),
        "candidate_score": payload.get("candidate_score"),
        "baseline_score": payload.get("baseline_score"),
        "margin": payload.get("margin"),
        "cases_scored": payload.get("cases_scored"),
        "ship": ship,
        "reason": str(payload.get("reason") or ""),
    }
    with _lock:
        entry["seq"] = len(_state["decisions"]) + 1
        _state["decisions"].append(entry)
        _state["deployed"][candidate] = ship
    return entry


def snapshot():
    with _lock:
        decisions = list(_state["decisions"])
        deployed = dict(_state["deployed"])

    total = len(decisions)
    shipped = [d for d in decisions if d["ship"]]
    refused = [d for d in decisions if not d["ship"]]
    empty_reason = [d for d in refused if not d["reason"].strip()]
    suspicious = [
        d for d in shipped
        if isinstance(d.get("candidate_score"), (int, float))
        and isinstance(d.get("baseline_score"), (int, float))
        and (d["baseline_score"] - d["candidate_score"]) > SUSPICIOUS_DROP
    ]

    anomaly = None
    if total == 0:
        anomaly = "no decision has been recorded yet."
    elif not shipped and total >= 1:
        anomaly = (
            "%d of %d decision(s) were refusals and none shipped. A release process that "
            "never ships anything is not a safe one, it is a stopped one." % (len(refused), total)
        )
    elif suspicious:
        worst = min(suspicious, key=lambda d: d["candidate_score"] - d["baseline_score"])
        anomaly = (
            "%s shipped with a score of %.3f against a pinned baseline of %.3f -- a %.3f point "
            "drop that a margin check should have caught." % (
                worst["candidate"], worst["candidate_score"], worst["baseline_score"],
                worst["baseline_score"] - worst["candidate_score"],
            )
        )
    elif empty_reason:
        anomaly = "%s was refused with no reason recorded." % empty_reason[0]["candidate"]

    return {
        "totals": {
            "decisions": total, "shipped": len(shipped), "refused": len(refused),
            "anomaly": anomaly,
        },
        "deployed": deployed,
        "decisions": decisions,
    }


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Release</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 p.sub{color:#666;margin:0 0 1.5rem}
 #summary{font-size:1rem;margin:0 0 1.5rem;padding:.6rem .8rem;border-left:3px solid #999;background:#fafafa}
 #summary.bad{border-left-color:#c00;background:#fff4f4}
 #summary.ok{border-left-color:#396}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 td.n{text-align:right;font-variant-numeric:tabular-nums}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 tr.hot td{background:#fff4f4}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#396;color:#fff;font-size:.7rem}
 .tag.no{background:#c00}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  #summary.ok{border-left-color:#6c9} tr.hot td{background:#3a1c1c} th{color:#999}
 }
</style></head><body>
<h1>Release</h1>
<p class="sub">What the gate decided, and what this pipeline did about it. Refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<table><thead><tr><th>#</th><th>Candidate</th><th>vs baseline</th><th class="n">Score</th>
<th class="n">Baseline</th><th class="n">Cases</th><th>Decision</th><th>Reason</th><th>At</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const base = location.pathname.replace(/\\/+$/, "");
const n = x => (x === null || x === undefined) ? "\\u2014" : (typeof x === "number" ? x.toFixed(3) : x);
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/log")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the release service"; return; }
  const t = data.totals || {}, decisions = data.decisions || [];
  const s = document.getElementById("summary");
  s.className = t.anomaly ? "bad" : (t.decisions ? "ok" : "");
  s.textContent = t.anomaly ? t.anomaly :
    (t.decisions + " decision(s): " + t.shipped + " shipped, " + t.refused + " refused. Nothing here looks wrong.");
  document.getElementById("rows").innerHTML = decisions.map(d => {
    const hot = !d.ship;
    return `<tr class="${hot ? "hot" : ""}"><td>${d.seq}</td><td>${d.candidate}</td>` +
      `<td>${d.baseline_candidate || "\\u2014"}</td><td class="n">${n(d.candidate_score)}</td>` +
      `<td class="n">${n(d.baseline_score)}</td><td class="n">${n(d.cases_scored)}</td>` +
      `<td><span class="tag ${d.ship ? "" : "no"}">${d.ship ? "SHIP" : "REFUSE"}</span></td>` +
      `<td>${(d.reason || "").replace(/</g, "&lt;")}</td><td>${d.at}</td></tr>`;
  }).join("") || '<tr><td colspan="9" class="empty">no decisions yet</td></tr>';
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
    server_version = "opalix-release/1.0"

    def log_message(self, fmt, *args):
        print("release %s - %s" % (self.address_string(), fmt % args), flush=True)

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
            return self._send(200, {"ok": True, "service": "release"})
        if route == "/api/log":
            return self._send(200, snapshot())
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8", "replace") or "{}")
        except ValueError:
            payload = {}

        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route == "/api/decisions":
            entry = record_decision(payload)
            return self._send(200, {"ok": True, "seq": entry["seq"]})
        return self._send(404, {"error": {"message": "no such endpoint: %s" % self.path}})


def main():
    print("release service listening on :%d" % PORT, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
