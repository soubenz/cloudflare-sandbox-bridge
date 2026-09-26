#!/usr/bin/env python3
"""Stand-in for the warehouse stock service -- and for its own record of
what it sent you.

There is no real stock system in this lab and no route out of the container
to one. This service answers ``GET /api/stock?sku=SKU-nnnn`` the way the real
one does, keeps the shelf counts that the shop actually has, and -- the part
that matters here -- logs every request next to *what it served for it*.
``/api/log`` and the **inventory** tab are that log. They are not a
reconstruction of what the agent did; they are what this service handed over.

Four things about it are worth reading before you debug the agent:

1. It answers 200 for almost everything, on purpose, because that is what
   this API does: it reports trouble in the body rather than in the status
   line. ``status`` is ``ok`` or it is not; ``items`` has one row per stock
   location it could report on; ``as_of`` is when the figures in the body
   were true.

2. ``items: []`` means "I have no row for that SKU" -- the index that
   answered does not have it. It does not mean the shelf is empty. A shelf
   that is empty is a row that says ``on_hand: 0``, and this service serves
   one of those too.

3. There is a cache in front of it. When the cache answers, the body is a
   normal 200 with a normal row in it and an ``as_of`` from whenever the
   figures were taken. Nothing in the response says the word cache and no
   header carries an age. The only thing that makes it old is the timestamp.

4. It fails, and caches, and comes good again, on purpose and
   deterministically, for fixed lists of SKUs read from its environment at
   start-up. Nothing here is random and nothing here branches on the clock.
   (``as_of`` is a value in a body, not a branch: which SKUs are served from
   the cache is fixed, and the graders assert on the outcome this service
   recorded rather than on any elapsed time.)

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PORT = int(os.environ.get("INVENTORY_PORT", "8925"))

# Deterministic fault injection, all of it keyed to the SKU:
#
#   DEGRADED_*   the slow shard: the first N requests for the SKU come back
#                200 with status "degraded" and no items, and everything
#                after them is a proper reading. This is the reading that
#                has to survive being asked for twice.
#   STUCK_*      a shard that has been down since Friday: every request for
#                the SKU is a degraded 200. No number of retries gets a
#                reading, and the honest answer is that we do not know.
#   BLANK_*      a SKU the answering index does not have: status ok, items
#                empty. Not a shelf with nothing on it.
#   CACHED_*     served from the cache, with an as_of CACHE_AGE_S old and
#                whatever the count was then.
DEGRADED = [s for s in os.environ.get("INVENTORY_DEGRADED_SKUS", "").split(",") if s]
DEGRADED_CALLS = int(os.environ.get("INVENTORY_DEGRADED_CALLS", "1"))
STUCK = [s for s in os.environ.get("INVENTORY_STUCK_SKUS", "").split(",") if s]
BLANK = [s for s in os.environ.get("INVENTORY_BLANK_SKUS", "").split(",") if s]
CACHED = [s for s in os.environ.get("INVENTORY_CACHED_SKUS", "").split(",") if s]
CACHE_AGE_S = int(os.environ.get("INVENTORY_CACHE_AGE_S", "64800"))
SLOW_SECONDS = float(os.environ.get("INVENTORY_SLOW_SECONDS", "4.0"))

ROUTES = ("/api/stock", "/api/shelf", "/api/log", "/api/reset", "/api/degrade", "/healthz")

# What is actually on the shelf, right now, whatever this service manages to
# say about it. `cached_on_hand` is what the cache in front of it still
# believes, for the SKUs it is answering for.
CATALOGUE = [
    {"sku": "SKU-4417", "item": "Lumen desk lamp", "on_hand": 14, "location": "BER-1"},
    {"sku": "SKU-5062", "item": "Harbour wool throw", "on_hand": 9, "location": "BER-1"},
    {"sku": "SKU-6810", "item": "Tidewater mug set of four", "on_hand": 31, "location": "BER-2"},
    {"sku": "SKU-7723", "item": "Alder side table", "on_hand": 0, "location": "BER-1"},
    {"sku": "SKU-8091", "item": "Field canvas tote", "on_hand": 47, "location": "BER-2"},
    {"sku": "SKU-2245", "item": "Sona floor rug", "on_hand": 26, "location": "BER-2",
     "cached_on_hand": 0},
    {"sku": "SKU-3364", "item": "Copper stovetop kettle", "on_hand": 5, "location": "BER-1"},
    {"sku": "SKU-9915", "item": "Ridge linen duvet", "on_hand": 63, "location": "BER-1"},
    {"sku": "SKU-1180", "item": "Ember wall clock", "on_hand": 22, "location": "BER-1"},
    {"sku": "SKU-6602", "item": "Brindle cushion", "on_hand": 3, "location": "BER-2"},
]
SHELF = {row["sku"]: row for row in CATALOGUE}

_lock = threading.Lock()
_state = {
    "requests": [],     # every request, with what was served for it
    "asked": {},        # sku -> requests answered since the last reset
    # The Friday afternoon the pressure event puts back on. Off by default,
    # stepped by request count rather than by the clock, and cleared by
    # /api/reset -- so it changes what a learner sees by hand and never what
    # a grader sees.
    "degrade": {"on": False, "served": 0},
}


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8925/api/stock and behind the session proxy at
    /sessions/<id>/services/inventory/api/stock."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _stamp(offset_s=0):
    """An as_of timestamp, in the shape every response carries one."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - offset_s))


def _sku(raw_request, params):
    """Finds which SKU a request is about.

    Deliberately not tied to the request's layout. Which SKUs fail, cache or
    come good is keyed to the SKU, and the ``sku`` query parameter only has
    that name because agent/inventory.py happens to use it today. A learner
    who switches to a path segment, a header or a POST body while looking
    around is not making the bug worse, and should not silently turn the
    faults off and then be told their retries are missing. So: match the SKU
    anywhere in the whole request line first, and fall back to the parameter.
    """
    match = re.search(r"\bSKU-\d{4}\b", raw_request)
    if match:
        return match.group(0)
    values = params.get("sku") or params.get("id") or []
    return values[0].strip() if values and values[0].strip() else "unknown"


def _record(sku, attempt, outcome, body, delayed_s=None):
    """Appends one line to the record. Called with the lock held."""
    items = body.get("items") or []
    served = items[0].get("on_hand") if items else None
    row = SHELF.get(sku)
    _state["requests"].append(
        {
            "seq": len(_state["requests"]) + 1,
            "sku": sku,
            "item": row["item"] if row else "(not in the catalogue)",
            "attempt": attempt,
            "outcome": outcome,
            "http_status": 503 if outcome == "refused_unavailable" else 200,
            "body_status": body.get("status"),
            "rows": len(items),
            "served_on_hand": served,
            "as_of": body.get("as_of"),
            "age_s": body.get("_age_s", 0),
            "on_shelf_now": row["on_hand"] if row else None,
            "delayed_s": delayed_s,
            "at": _now(),
        }
    )


def _reading(sku, offset_s=0, on_hand=None, partial=False):
    """A normal 200 with a row in it, as of ``offset_s`` ago."""
    row = SHELF.get(sku)
    if row is None:
        # Not a fault: a SKU this shop does not sell has no row, and says so
        # the only way this API can -- an empty list.
        return {"status": "ok", "as_of": _stamp(), "items": [], "_age_s": 0}
    item = {"sku": sku, "location": row["location"]}
    if not partial:
        item["on_hand"] = row["on_hand"] if on_hand is None else on_hand
    return {"status": "ok", "as_of": _stamp(offset_s), "items": [item], "_age_s": offset_s}


def _degraded(sku):
    return {
        "status": "degraded",
        "message": "stock database did not respond in time; the figures below are incomplete",
        "as_of": _stamp(),
        "items": [],
        "_age_s": 0,
    }


def stock(sku):
    """Answers one stock request. Returns (http_status, body, delay_s).

    Which SKUs fail, which are served from the cache and which come good on
    the second ask are fixed functions of (SKU, requests seen since the last
    reset). The body is built and recorded first; the last thing this
    function decides is what the caller gets to hear about it.
    """
    with _lock:
        attempt = _state["asked"].get(sku, 0) + 1
        _state["asked"][sku] = attempt

        stage = None
        if _state["degrade"]["on"]:
            _state["degrade"]["served"] += 1
            nth = _state["degrade"]["served"]
            stage = "partial" if nth <= 3 else "slow" if nth <= 6 else "outage" if nth <= 9 else None
            if stage is None:
                _state["degrade"] = {"on": False, "served": 0}
                print("inventory: the degraded window has passed", flush=True)

        if stage == "outage":
            body = {"status": "error", "message": "stock service is unavailable"}
            _record(sku, attempt, "refused_unavailable", body)
            return 503, body, 0.0
        if stage == "partial":
            # The page was cut short: the row is there, the count is not.
            body = _reading(sku, partial=True)
            _record(sku, attempt, "served_partial_row", body)
            return 200, body, 0.0

        if sku in STUCK or (sku in DEGRADED and attempt <= DEGRADED_CALLS):
            body = _degraded(sku)
            _record(sku, attempt, "served_degraded", body)
            return 200, body, 0.0

        if sku in BLANK:
            body = {"status": "ok", "as_of": _stamp(), "items": [], "_age_s": 0}
            _record(sku, attempt, "served_no_row", body)
            return 200, body, 0.0

        if sku in CACHED:
            row = SHELF.get(sku) or {}
            body = _reading(sku, offset_s=CACHE_AGE_S,
                            on_hand=row.get("cached_on_hand", row.get("on_hand", 0)))
            _record(sku, attempt, "served_from_cache", body)
            return 200, body, 0.0

        body = _reading(sku)
        delay = SLOW_SECONDS if stage == "slow" else 0.0
        _record(sku, attempt, "served_reading", body, delayed_s=delay or None)
        return 200, body, delay


def by_sku():
    """One row per SKU: what it was asked, what it was served. Lock held."""
    rows = {}
    for request in _state["requests"]:
        row = rows.setdefault(
            request["sku"],
            {
                "sku": request["sku"],
                "item": request["item"],
                "requests": 0,
                "readings": 0,
                "outcomes": {},
                "last_outcome": None,
                "last_served_on_hand": None,
                "last_age_s": None,
                "on_shelf_now": request["on_shelf_now"],
            },
        )
        row["requests"] += 1
        row["outcomes"][request["outcome"]] = row["outcomes"].get(request["outcome"], 0) + 1
        if request["outcome"] == "served_reading":
            row["readings"] += 1
        row["last_outcome"] = request["outcome"]
        row["last_served_on_hand"] = request["served_on_hand"]
        row["last_age_s"] = request["age_s"]
    return rows


def snapshot(include_requests=True):
    with _lock:
        rows = sorted(by_sku().values(), key=lambda r: (r["readings"] > 0, r["sku"]))
        out = {
            "totals": {
                "requests": len(_state["requests"]),
                "readings": sum(1 for r in _state["requests"] if r["outcome"] == "served_reading"),
                "skus": len(rows),
                "max_reading_age_s": int(os.environ.get("MAX_READING_AGE_S", "900")),
                "degrading": bool(_state["degrade"]["on"]),
            },
            "by_sku": rows,
            "shelf": [
                {"sku": r["sku"], "item": r["item"], "on_hand": r["on_hand"]}
                for r in CATALOGUE
            ],
        }
        if include_requests:
            out["requests"] = list(_state["requests"])
        return out


def reset():
    with _lock:
        _state["requests"] = []
        _state["asked"] = {}
        _state["degrade"] = {"on": False, "served": 0}


def start_degrading():
    """Puts Friday afternoon back on. Idempotent: already on stays on."""
    with _lock:
        if _state["degrade"]["on"]:
            return {"ok": True, "degrading": True, "already": True}
        _state["degrade"] = {"on": True, "served": 0}
        return {"ok": True, "degrading": True, "already": False}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Inventory</title>
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
 tr.bad td{background:#fff4f4}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .tag.warn{background:#a60}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  tr.bad td{background:#3a1c1c} th{color:#999}
 }
</style></head><body>
<h1>Inventory</h1>
<p class="sub">What the stock service served this run, per SKU, next to what is on the shelf. Refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<h2>By SKU</h2>
<table><thead><tr><th>SKU</th><th>Item</th><th class="n">Requests</th><th class="n">Readings</th>
<th>What it served</th><th class="n">Count in that body</th><th class="n">Age of it</th><th class="n">On the shelf now</th></tr></thead>
<tbody id="rows"></tbody></table>
<h2>Last 20 requests</h2>
<table><thead><tr><th>#</th><th>SKU</th><th class="n">Ask</th><th class="n">HTTP</th><th>Body status</th>
<th class="n">Rows</th><th class="n">on_hand</th><th>as_of</th><th>Outcome</th><th>At</th></tr></thead>
<tbody id="requests"></tbody></table>
<script>
const base = location.pathname.replace(/\\/+$/, "");
const WORDS = {
  served_reading: "a reading",
  served_degraded: "an error in the body of a 200",
  served_no_row: "a 200 with no row for the SKU",
  served_from_cache: "the cache, not the shelf",
  served_partial_row: "a row with the count cut off it",
  refused_unavailable: "HTTP 503, nothing at all"
};
const age = s => s === null || s === undefined ? "—" :
  s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : (s / 3600).toFixed(1) + "h";
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/shelf")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the stock service"; return; }
  const t = data.totals || {}, rows = data.by_sku || [], requests = data.requests || [];
  const fresh = r => r.last_outcome === "served_reading" && r.last_age_s <= (t.max_reading_age_s || 900);
  const blind = rows.filter(r => !fresh(r));
  const s = document.getElementById("summary");
  s.className = blind.length ? "bad" : "";
  s.textContent = (t.requests || 0) + " request(s) for " + rows.length + " SKU(s); " +
    (t.readings || 0) + " of them were answered with a reading. " +
    (blind.length
      ? blind.length + " SKU(s) were never read successfully: " +
        blind.map(r => r.sku + " (" + (WORDS[r.last_outcome] || r.last_outcome) +
          (r.last_outcome === "served_from_cache" ? ", " + age(r.last_age_s) + " old" : "") +
          ", and there are " + r.on_shelf_now + " on the shelf)").join("; ") +
        ". Anything a customer was told about those is not something this service said."
      : "Every SKU asked about got a reading.") +
    (t.degrading ? " The service is in a degraded window right now." : "");
  document.getElementById("rows").innerHTML = rows.map(r => {
    const wrong = !fresh(r);
    return `<tr class="${wrong ? "bad" : ""}"><td>${r.sku}` +
      (wrong ? ' <span class="tag">not a reading</span>' : "") +
      (r.last_outcome === "served_from_cache" ? ' <span class="tag warn">from the cache</span>' : "") +
      `</td><td>${r.item}</td><td class="n">${r.requests}</td><td class="n">${r.readings}</td>` +
      `<td>${WORDS[r.last_outcome] || r.last_outcome}</td>` +
      `<td class="n">${r.last_served_on_hand === null ? "—" : r.last_served_on_hand}</td>` +
      `<td class="n">${age(r.last_age_s)}</td><td class="n">${r.on_shelf_now}</td></tr>`;
  }).join("") || '<tr><td colspan="8" class="empty">no requests yet</td></tr>';
  document.getElementById("requests").innerHTML = requests.slice(-20).reverse().map(r =>
    `<tr class="${r.outcome === "served_reading" ? "" : "bad"}"><td>${r.seq}</td><td>${r.sku}</td>` +
    `<td class="n">${r.attempt}</td><td class="n">${r.http_status}</td><td><code>${r.body_status || "—"}</code></td>` +
    `<td class="n">${r.rows}</td><td class="n">${r.served_on_hand === null ? "—" : r.served_on_hand}</td>` +
    `<td><code>${r.as_of || "—"}</code></td><td><code>${r.outcome}</code>` +
    (r.delayed_s ? " after " + r.delayed_s + "s" : "") + `</td><td>${r.at}</td></tr>`).join("");
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-inventory/1.0"

    def log_message(self, fmt, *args):  # one line per request, on stdout
        print("inventory %s - %s" % (self.address_string(), fmt % args), flush=True)

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
            return self._send(200, {"ok": True, "service": "inventory"})
        if route == "/api/log":
            return self._send(200, snapshot())
        if route == "/api/shelf":
            # Same numbers, last 20 requests only, for the page that polls it.
            data = snapshot()
            data["requests"] = data["requests"][-20:]
            return self._send(200, data)
        if route == "/api/stock":
            params = parse_qs(urlsplit(self.path).query)
            status, body, delay = stock(_sku(self.path, params))
            if delay:
                # Slower than the caller's timeout, on purpose, so the
                # caller has to decide what to do about hearing nothing.
                time.sleep(delay)
            served = {k: v for k, v in body.items() if not k.startswith("_")}
            try:
                return self._send(status, served)
            except (BrokenPipeError, ConnectionResetError):
                # The caller gave up waiting and closed the socket. That is
                # the whole point of the slow stage, so it is not an error
                # here -- and letting the traceback print would put a red
                # herring in the log of a lab about what the caller heard.
                return None
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route == "/api/degrade":
            return self._send(200, start_degrading())
        if route == "/api/stock":
            # Same answer as the GET: a learner who switches to a POST is not
            # changing which SKUs are broken.
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8", "replace") if length else "{}"
            status, body, delay = stock(_sku(self.path + " " + raw, {}))
            if delay:
                time.sleep(delay)
            served = {k: v for k, v in body.items() if not k.startswith("_")}
            try:
                return self._send(status, served)
            except (BrokenPipeError, ConnectionResetError):
                return None
        return self._send(404, {"error": {"message": "no such endpoint: %s" % self.path}})


def main():
    print(
        "inventory listening on :%d (degraded for %s x%d, stuck %s, no row for %s, "
        "cache %ds old for %s; %d SKUs on the shelf)"
        % (
            PORT, ",".join(DEGRADED) or "-", DEGRADED_CALLS, ",".join(STUCK) or "-",
            ",".join(BLANK) or "-", CACHE_AGE_S, ",".join(CACHED) or "-", len(CATALOGUE),
        ),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
