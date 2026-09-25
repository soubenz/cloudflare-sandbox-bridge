#!/usr/bin/env python3
"""The conversation store -- and therefore the transcript support reads.

Every replica of the desk writes here. There is one append-only thread per
conversation: the customer's turns and the desk's replies, in the order the
store received them, each row stamped with which replica wrote it. There is
also a small per-turn scratchpad, the checkpoint, which a replica can use to
record how far it got through a turn before anything else happened.

Four things about it are worth reading before you debug the desk:

1. **It is the only thing in this lab that sees the whole conversation.**
   Each replica sees the turns it happened to handle. The store sees all of
   them, so the thread on ``/api/thread`` and in the **transcript** tab is
   what the customer experienced, not what any one process believes.

2. **It hands out replica identities.** A replica registers itself on start
   with ``POST /api/replicas`` and gets back an opaque id. Every write has
   to carry that id in ``X-Replica`` or the store refuses it. The store
   numbers registrations in the order they arrive, which is a race between
   two processes starting at the same time, so *which* replica is ``r1`` is
   not stable from run to run and nothing should depend on it.

3. **An append that is recorded is recorded.** For one configured
   conversation the store writes the row and *then* loses the connection,
   exactly as a store under load does. The row is in the thread; the caller
   never heard so.

4. **The checkpoint is a place, not a policy.** The store will store
   anything under ``(conversation, turn)`` and hand it back to anybody who
   asks, including a different replica. It has no opinion about what a
   replica puts there or when.

It fails on purpose and deterministically, keyed to a conversation id and to
how many appends that conversation has seen since the last reset. Nothing
here is random and nothing here looks at the clock.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

PORT = int(os.environ.get("TRANSCRIPT_PORT", "8851"))

# Which append to lose the connection on, as `<conversation>:<nth append>`.
# The nth is counted per conversation and reset by /api/reset, so it fires on
# exactly the same write every run. The row is stored before the failure.
_DROP = os.environ.get("STORE_FAULT_DROP_APPENDS", "")
DROP_APPENDS = {}
for _entry in [e for e in _DROP.split(",") if e]:
    _cid, _, _nth = _entry.partition(":")
    try:
        DROP_APPENDS[_cid.strip()] = int(_nth)
    except ValueError:
        pass

ROUTES = (
    "/api/replicas",
    "/api/thread",
    "/api/threads",
    "/api/turns",
    "/api/checkpoint",
    "/api/log",
    "/api/reset",
    "/healthz",
)

_lock = threading.Lock()
_state = {
    "turns": [],          # every row, in the order the store accepted it
    "checkpoints": {},    # "<conversation>|<turn>" -> whatever a replica stored
    "replicas": [],       # [{"replica_id": "r1", "name": ..., "at": ...}]
    "appends": {},        # conversation -> append calls handled since reset
    "seq": 0,
}


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8851/api/thread and behind the session proxy at
    /sessions/<id>/services/transcript/api/thread."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _query(path):
    return {k: v[0] for k, v in parse_qs(urlsplit(path).query).items()}


def _conversation_id(raw_body, field):
    """Finds which conversation a write is about.

    Deliberately not tied to the request's layout. Which conversation loses
    an append is keyed to the conversation id, and the ``conversation``
    field only exists because agent/store.py happens to send one today. A
    learner who renames that field, or nests it, is not making the bug worse
    and should not silently turn the fault off. So: match the id anywhere in
    the whole request body first, and fall back to the named field.
    """
    match = re.search(r"\bC-\d{4}\b", raw_body)
    if match:
        return match.group(0)
    return str(field or "unknown")


def register(name):
    with _lock:
        replica_id = "r%d" % (len(_state["replicas"]) + 1)
        _state["replicas"].append(
            {"replica_id": replica_id, "name": str(name or replica_id), "at": _now()}
        )
        return replica_id


def known_replica(replica_id):
    with _lock:
        return any(r["replica_id"] == replica_id for r in _state["replicas"])


def append(replica_id, conversation, turn, role, text, knew, facts):
    """Records one row. Returns (status, body).

    The row is committed to the thread before the branch that decides what
    the caller gets to hear about it.
    """
    with _lock:
        _state["seq"] += 1
        nth = _state["appends"].get(conversation, 0) + 1
        _state["appends"][conversation] = nth
        row = {
            "seq": _state["seq"],
            "conversation_id": conversation,
            "turn": turn,
            "role": role,
            "text": text,
            "knew": knew if isinstance(knew, dict) else {},
            "facts": facts if isinstance(facts, dict) else {},
            "replica": replica_id,
            "outcome": "stored",
            "at": _now(),
        }
        _state["turns"].append(row)

        # The row is now in the thread. Everything below decides only what
        # the caller gets to hear about it.
        if DROP_APPENDS.get(conversation) == nth:
            row["outcome"] = "stored_then_dropped"
            return 504, {"error": "the store lost the connection writing that row"}
        return 200, {"ok": True, "seq": row["seq"]}


def thread(conversation):
    with _lock:
        return [
            dict(row) for row in _state["turns"]
            if row["conversation_id"] == conversation
        ]


def put_checkpoint(conversation, turn, value):
    with _lock:
        _state["checkpoints"]["%s|%s" % (conversation, turn)] = {
            "conversation_id": conversation,
            "turn": turn,
            "value": value,
            "at": _now(),
        }


def get_checkpoint(conversation, turn):
    with _lock:
        record = _state["checkpoints"].get("%s|%s" % (conversation, turn))
        return dict(record) if record else None


def conversations():
    """One entry per conversation, with the anomalies the store can see.

    The store can see three things no replica can. Whether a turn is in the
    thread once, twice or not at all. Which replica wrote each row. And
    whether a reply was filed claiming to know less than the customer had
    already said in that same thread -- because the customer's own turns are
    right there above it. Lock held by the caller.
    """
    out = {}
    for row in _state["turns"]:
        entry = out.setdefault(
            row["conversation_id"],
            {"conversation_id": row["conversation_id"], "rows": [], "replicas": [],
             "duplicated": [], "forgot": []},
        )
        entry["rows"].append(row)
        if row["replica"] not in entry["replicas"]:
            entry["replicas"].append(row["replica"])

    for entry in out.values():
        seen = {}
        told = {}
        for row in sorted(entry["rows"], key=lambda r: r["seq"]):
            key = (row["turn"], row["role"])
            seen[key] = seen.get(key, 0) + 1
            if row["role"] == "customer":
                told.update(row["facts"])
            else:
                missing = sorted(k for k in told if k not in (row["knew"] or {}))
                if missing:
                    entry["forgot"].append({"turn": row["turn"], "missing": missing,
                                            "replica": row["replica"]})
        entry["duplicated"] = [
            {"turn": turn, "role": role, "times": count}
            for (turn, role), count in sorted(seen.items()) if count > 1
        ]
        entry["rows"] = sorted(entry["rows"], key=lambda r: r["seq"])
    return sorted(out.values(), key=lambda e: e["conversation_id"])


def snapshot():
    with _lock:
        return {
            "replicas": list(_state["replicas"]),
            "turns": [dict(r) for r in _state["turns"]],
            "checkpoints": [dict(c) for c in _state["checkpoints"].values()],
            "conversations": conversations(),
        }


def reset():
    with _lock:
        _state["turns"] = []
        _state["checkpoints"] = {}
        _state["replicas"] = []
        _state["appends"] = {}
        _state["seq"] = 0


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Transcript</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 h2{font-size:.95rem;margin:2rem 0 .5rem;color:#444}
 p.sub{color:#666;margin:0 0 1.5rem}
 #summary{font-size:1rem;margin:0 0 1.5rem;padding:.6rem .8rem;border-left:3px solid #999;background:#fafafa}
 #summary.bad{border-left-color:#c00;background:#fff4f4}
 table{border-collapse:collapse;width:100%;margin-bottom:.5rem}
 th,td{text-align:left;padding:.3rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
 code{font:12px/1.4 ui-monospace,Menlo,monospace}
 tr.forgot td{background:#fff4f4}
 tr.dupe td{background:#fff8e8}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .tag.warn{background:#a60}
 .tag.rep{background:#345;color:#fff}
 .empty{color:#666;padding:1rem 0}
 .conv{margin-bottom:2rem}
 .conv h3{font-size:.9rem;margin:0 0 .25rem}
 .note{color:#a00;font-size:.85rem;margin:.1rem 0 .5rem}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  tr.forgot td{background:#3a1c1c} tr.dupe td{background:#332a12} th{color:#999} .note{color:#f88}
 }
</style></head><body>
<h1>Transcript</h1>
<p class="sub">Every conversation as the store recorded it, whichever replica wrote the row. Refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<div id="threads"></div>
<script>
const base = location.pathname.replace(/\\/+$/, "");
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const kv = o => Object.keys(o || {}).length
  ? Object.keys(o).sort().map(k => k + "=" + o[k]).join(", ") : "\\u2014";
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/threads")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the store"; return; }
  const convs = data.conversations || [], reps = data.replicas || [];
  const forgot = convs.filter(c => c.forgot.length), dupe = convs.filter(c => c.duplicated.length);
  const single = convs.filter(c => c.replicas.length === 1 && c.rows.length > 2);
  const s = document.getElementById("summary");
  s.className = (forgot.length || dupe.length) ? "bad" : "";
  s.textContent = convs.length + " conversation(s) recorded by " + reps.length + " replica(s) (" +
    reps.map(r => r.replica_id + " = " + r.name).join(", ") + "). " +
    (forgot.length
      ? forgot.map(c => c.conversation_id + " was answered at turn " + c.forgot[0].turn +
          " without " + c.forgot[0].missing.join(" or ") + " the customer had already given, by " +
          c.forgot[0].replica).join("; ") + ". "
      : "No reply was filed knowing less than the customer had already said. ") +
    (dupe.length
      ? dupe.map(c => c.conversation_id + " has turn " + c.duplicated[0].turn + " recorded " +
          c.duplicated[0].times + " times").join("; ") + ". "
      : "No turn is recorded twice. ") +
    (single.length ? single.map(c => c.conversation_id + " was handled start to finish by one replica").join("; ") + "." : "");
  document.getElementById("threads").innerHTML = convs.map(c => {
    const bad = new Set(c.forgot.map(f => f.turn + "|assistant"));
    const dup = new Set(c.duplicated.map(d => d.turn + "|" + d.role));
    return '<div class="conv"><h3>' + esc(c.conversation_id) +
      ' <span class="tag rep">' + c.replicas.join(" + ") + '</span></h3>' +
      (c.forgot.length ? '<p class="note">answered without: ' +
        c.forgot.map(f => "turn " + f.turn + " missing " + f.missing.join(", ")).join("; ") + '</p>' : "") +
      '<table><thead><tr><th class="n">#</th><th class="n">Turn</th><th>Who</th><th>Said</th>' +
      '<th>Desk knew</th><th>Replica</th><th>Outcome</th></tr></thead><tbody>' +
      c.rows.map(r => {
        const key = r.turn + "|" + r.role;
        const cls = bad.has(key) && r.role !== "customer" ? "forgot" : (dup.has(key) ? "dupe" : "");
        return '<tr class="' + cls + '"><td class="n">' + r.seq + '</td><td class="n">' + r.turn +
          '</td><td>' + esc(r.role) +
          (dup.has(key) ? ' <span class="tag warn">twice</span>' : "") + '</td><td>' + esc(r.text) +
          '</td><td><code>' + esc(r.role === "customer" ? kv(r.facts) : kv(r.knew)) + '</code></td>' +
          '<td>' + esc(r.replica) + '</td><td><code>' + esc(r.outcome) + '</code></td></tr>';
      }).join("") + '</tbody></table></div>';
  }).join("") || '<p class="empty">nothing recorded yet</p>';
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-transcript/1.0"

    def log_message(self, fmt, *args):  # one line per request, on stdout
        print("transcript %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = _route(self.path)
        params = _query(self.path)
        if route == "/healthz":
            return self._send(200, {"ok": True, "service": "transcript"})
        if route == "/api/thread":
            return self._send(200, {"turns": thread(params.get("conversation", ""))})
        if route == "/api/checkpoint":
            record = get_checkpoint(params.get("conversation", ""), params.get("turn", ""))
            return self._send(200, {"checkpoint": record})
        if route == "/api/log":
            return self._send(200, snapshot())
        if route == "/api/threads":
            data = snapshot()
            return self._send(200, {"replicas": data["replicas"],
                                    "conversations": data["conversations"]})
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = (self.rfile.read(length) if length else b"{}").decode("utf-8", "replace")
        try:
            body = json.loads(raw or "{}")
        except ValueError:
            return self._send(400, {"error": "body must be JSON"})
        if not isinstance(body, dict):
            return self._send(400, {"error": "body must be a JSON object"})

        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})

        if route == "/api/replicas":
            return self._send(200, {"replica_id": register(body.get("name"))})

        replica_id = self.headers.get("X-Replica", "")
        if route == "/api/checkpoint":
            if not known_replica(replica_id):
                return self._send(403, {"error": "unknown replica %r; register on start"
                                                 % replica_id})
            conversation = _conversation_id(raw, body.get("conversation"))
            put_checkpoint(conversation, str(body.get("turn", "")), body.get("value"))
            return self._send(200, {"ok": True})

        if route == "/api/turns":
            if not known_replica(replica_id):
                return self._send(403, {"error": "unknown replica %r; register on start"
                                                 % replica_id})
            conversation = _conversation_id(raw, body.get("conversation"))
            role = "customer" if str(body.get("role")) == "customer" else "assistant"
            status, out = append(
                replica_id, conversation, str(body.get("turn", "")), role,
                str(body.get("text", "")), body.get("knew"), body.get("facts"),
            )
            try:
                return self._send(status, out)
            except (BrokenPipeError, ConnectionResetError):
                # The caller gave up on the socket. The row is stored either
                # way -- that is the point of the fault -- and letting the
                # traceback print would put a red herring in the log of a lab
                # about not trusting what the caller heard.
                return None

        return self._send(404, {"error": "no such endpoint: %s" % self.path})


def main():
    print(
        "transcript store listening on :%d (append dropped for %s)"
        % (PORT, ", ".join("%s at append #%d" % kv for kv in sorted(DROP_APPENDS.items())) or "-"),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
