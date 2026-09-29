#!/usr/bin/env python3
"""The access-request portal: teams ask for LiteLLM model access, an
approver signs off, and only then does anything real get provisioned.

Reference solution -- never published to the learner
(docs/lab-authoring.md). Identical to the workspace skeleton except for
`_handle_approve` / `_claim_for_approval`: approving is made idempotent, so
a double-click, a retried request, or two approvers racing each other
provisions LiteLLM access exactly once.

Three endpoints, backed by a small local SQLite database (this portal's own
system of record -- LiteLLM's own database is the gateway's, not this
service's, same "local stand-in" convention as every other lab in this
repo):

  POST /requests
      Body: {"team": "...", "models_needed": ["...", ...], "justification": "..."}
      Creates a real pending request row and returns its id. Grants
      nothing -- there is no LiteLLM call anywhere in this handler.

  POST /requests/{id}/approve
      Header: Authorization: Bearer <token>
      Only a caller holding APPROVER_TOKEN may call this. On success it
      talks to LiteLLM's own admin API with the proxy's master key,
      synchronously, right here in this handler: the team is created (or,
      if it already exists, extended with the newly requested models) and
      a real key is minted for it. Calling it again for the same request
      -- concurrently or long after the fact -- never provisions a second
      time: it just returns the same already-recorded result.

  GET /requests/{id}
      Shows the request's current status, and once it is approved, the
      real key the team should use.

Run it directly:

    LITELLM_URL=http://127.0.0.1:4000 LITELLM_MASTER_KEY=... \\
    APPROVER_TOKEN=... python3 -B portal/app.py

Env:
  PORTAL_PORT      default 8973
  LITELLM_URL      default http://127.0.0.1:4000
  LITELLM_MASTER_KEY
  APPROVER_TOKEN   the one credential this lab accepts on /approve. A real
                   platform would look this up per-approver; one fixed
                   token is enough to teach the shape of the check.
  PORTAL_DB_PATH   default /tmp/access-request-portal/requests.db (kept out
                   of /workspace, same reasoning as every Postgres data dir
                   in this repo: /workspace is chowned to `learner`)
"""

import hmac
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG_PATH = os.path.join(HERE, "models.yaml")

PORT = int(os.environ.get("PORTAL_PORT", "8973"))
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
APPROVER_TOKEN = os.environ.get("APPROVER_TOKEN", "")
DB_PATH = os.environ.get("PORTAL_DB_PATH", "/tmp/access-request-portal/requests.db")

APPROVE_RE = re.compile(r"^/requests/(\d+)/approve$")
REQUEST_RE = re.compile(r"^/requests/(\d+)$")

# How long a caller who lost the idempotency race waits for the winner to
# finish provisioning before giving up and reporting the current state
# as-is. Provisioning is two or three LiteLLM admin calls -- generous
# against this lab's own fake provider and a local gateway.
CLAIM_WAIT_TIMEOUT_S = 15
CLAIM_POLL_INTERVAL_S = 0.1


# ------------------------------------------------------------------ catalog

def _load_catalog():
    with open(CATALOG_PATH) as f:
        doc = yaml.safe_load(f) or {}
    models = doc.get("models") or []
    if not isinstance(models, list) or not all(isinstance(m, str) for m in models):
        raise RuntimeError("%s: `models` must be a list of strings" % CATALOG_PATH)
    return models


CATALOG = _load_catalog()


# ---------------------------------------------------------------------- db

def _db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    conn = _db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                team TEXT NOT NULL,
                models_needed TEXT NOT NULL,
                justification TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at REAL NOT NULL,
                approved_at REAL,
                team_id TEXT,
                key_value TEXT,
                key_alias TEXT,
                last_error TEXT
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def _create_request(team, models_needed, justification):
    conn = _db()
    try:
        cur = conn.execute(
            "INSERT INTO requests (team, models_needed, justification, status, created_at) "
            "VALUES (?, ?, ?, 'pending', ?)",
            (team, json.dumps(models_needed), justification, time.time()),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def _get_request(request_id):
    conn = _db()
    try:
        row = conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def _claim_for_approval(request_id):
    """Atomically flip status pending -> approving and report whether THIS
    call is the one that won that race. The UPDATE's WHERE clause and
    SQLite's own single-writer serialization together make this safe
    against two /approve calls (or a retried one) landing at the same
    time: whichever commits first is the only one whose UPDATE can match
    `status = 'pending'`, because by the time the second one's UPDATE runs
    the row's status is no longer 'pending'."""
    conn = _db()
    try:
        cur = conn.execute(
            "UPDATE requests SET status = 'approving' WHERE id = ? AND status = 'pending'",
            (request_id,),
        )
        conn.commit()
        return cur.rowcount == 1
    finally:
        conn.close()


def _update_approved(request_id, team_id, key_value, key_alias):
    conn = _db()
    try:
        conn.execute(
            "UPDATE requests SET status = 'approved', team_id = ?, key_value = ?, "
            "key_alias = ?, approved_at = ?, last_error = NULL WHERE id = ?",
            (team_id, key_value, key_alias, time.time(), request_id),
        )
        conn.commit()
    finally:
        conn.close()


def _revert_to_pending(request_id, error):
    """Provisioning failed after we'd already claimed the row -- put it
    back to 'pending' so a later /approve call can actually retry, instead
    of leaving it stuck in 'approving' forever."""
    conn = _db()
    try:
        conn.execute(
            "UPDATE requests SET status = 'pending', last_error = ? WHERE id = ?",
            (error, request_id),
        )
        conn.commit()
    finally:
        conn.close()


def _wait_for_terminal(request_id, deadline):
    """Used only by a caller that just lost the claim race: poll until the
    request currently being approved by someone else reaches a terminal
    state (approved, or back to pending if that other attempt failed),
    then report whatever it is -- never provisions anything itself."""
    while time.time() < deadline:
        row = _get_request(request_id)
        if row is None or row["status"] != "approving":
            return row
        time.sleep(CLAIM_POLL_INTERVAL_S)
    return _get_request(request_id)


def _public_view(row):
    return {
        "id": row["id"],
        "team": row["team"],
        "models_needed": json.loads(row["models_needed"]),
        "justification": row["justification"],
        "status": row["status"],
        "created_at": row["created_at"],
        "approved_at": row["approved_at"],
        "team_id": row["team_id"],
        "key": row["key_value"] if row["status"] == "approved" else None,
        "key_alias": row["key_alias"] if row["status"] == "approved" else None,
    }


# ---------------------------------------------------------- LiteLLM client

def _litellm(method, path, body=None):
    """Minimal JSON HTTP helper against LiteLLM's own admin API, using the
    proxy's master key. Never raises on a non-2xx response -- LiteLLM's
    management API answers plenty of deliberate 400s, and those are data,
    not exceptions."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        LITELLM_URL + path, data=data, method=method,
        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
    )
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def _find_team(team_alias):
    status, body = _litellm("GET", "/team/list")
    if status != 200 or not isinstance(body, list):
        raise RuntimeError("could not list teams: %s %r" % (status, body))
    for t in body:
        if t.get("team_alias") == team_alias:
            return t
    return None


def provision(team, models_needed, request_id):
    """Create the team if it doesn't exist yet, or extend its model list if
    it does, then mint a fresh key for it. Real, synchronous LiteLLM admin
    API calls. Only ever called once per request -- see
    `_handle_approve`."""
    existing = _find_team(team)
    if existing is None:
        status, body = _litellm(
            "POST", "/team/new",
            {"team_alias": team, "models": models_needed},
        )
        if status != 200:
            raise RuntimeError("could not create team %r: %s %r" % (team, status, body))
        team_id = body["team_id"]
    else:
        team_id = existing["team_id"]
        union_models = sorted(set(existing.get("models") or []) | set(models_needed))
        status, body = _litellm(
            "POST", "/team/update",
            {"team_id": team_id, "models": union_models},
        )
        if status != 200:
            raise RuntimeError("could not extend team %r: %s %r" % (team, status, body))

    # LiteLLM requires key_alias to be unique across every key on the
    # gateway, so a short random suffix is included. Harmless here since
    # `provision` is only ever called once per request (see
    # `_handle_approve` / `_claim_for_approval` above).
    key_alias = "%s-request-%s-%s" % (team, request_id, uuid.uuid4().hex[:8])
    status, body = _litellm(
        "POST", "/key/generate",
        {"team_id": team_id, "key_alias": key_alias},
    )
    if status != 200:
        raise RuntimeError("could not create a key for team %r: %s %r" % (team, status, body))
    return team_id, body["key"], key_alias


# -------------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-access-portal/1.0"

    def log_message(self, fmt, *args):
        print("portal %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}, None
        try:
            return json.loads(raw), None
        except ValueError as e:
            return None, "body must be valid JSON: %s" % e

    def _bearer_token(self):
        auth = self.headers.get("Authorization") or ""
        if not auth.lower().startswith("bearer "):
            return None
        return auth[7:].strip()

    # ---- routes ----

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            return self._send(200, {"ok": True, "service": "portal"})
        m = REQUEST_RE.match(path)
        if m:
            return self._handle_get(int(m.group(1)))
        return self._send(404, {"error": "no such endpoint: %s" % path})

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/requests":
            return self._handle_create()
        m = APPROVE_RE.match(path)
        if m:
            return self._handle_approve(int(m.group(1)))
        return self._send(404, {"error": "no such endpoint: %s" % path})

    # ---- handlers ----

    def _handle_create(self):
        body, err = self._read_json()
        if err:
            return self._send(400, {"error": err})

        team = body.get("team")
        models_needed = body.get("models_needed")
        justification = body.get("justification")

        if not isinstance(team, str) or not team.strip():
            return self._send(400, {"error": "`team` is required"})
        if not isinstance(models_needed, list) or not models_needed or not all(
            isinstance(m, str) for m in models_needed
        ):
            return self._send(400, {"error": "`models_needed` must be a non-empty list of model names"})
        if not isinstance(justification, str) or not justification.strip():
            return self._send(400, {"error": "`justification` is required"})
        unknown = sorted(set(models_needed) - set(CATALOG))
        if unknown:
            return self._send(400, {
                "error": "unknown model(s) %r -- this portal only knows about %r" % (unknown, CATALOG),
            })

        request_id = _create_request(team.strip(), sorted(set(models_needed)), justification.strip())
        row = _get_request(request_id)
        return self._send(201, _public_view(row))

    def _handle_get(self, request_id):
        row = _get_request(request_id)
        if row is None:
            return self._send(404, {"error": "no such request"})
        return self._send(200, _public_view(row))

    def _handle_approve(self, request_id):
        token = self._bearer_token()
        if not token:
            return self._send(401, {"error": "missing bearer token"})
        if not hmac.compare_digest(token, APPROVER_TOKEN):
            return self._send(403, {"error": "not an approver credential"})

        row = _get_request(request_id)
        if row is None:
            return self._send(404, {"error": "no such request"})

        # The fix: only the caller whose UPDATE actually flips
        # pending -> approving goes on to call LiteLLM at all. Every other
        # caller for this same request -- a literal retry, a second
        # approver double-clicking, two requests racing -- just waits for
        # that one attempt to finish and reports its result. No branch of
        # this function calls `provision` more than once per request.
        won = _claim_for_approval(request_id)
        if not won:
            row = _wait_for_terminal(request_id, time.time() + CLAIM_WAIT_TIMEOUT_S)
            if row is None:
                return self._send(404, {"error": "no such request"})
            return self._send(200, _public_view(row))

        try:
            team_id, key_value, key_alias = provision(
                row["team"], json.loads(row["models_needed"]), request_id,
            )
        except Exception as e:
            _revert_to_pending(request_id, str(e))
            return self._send(502, {"error": "provisioning failed: %s" % e})

        _update_approved(request_id, team_id, key_value, key_alias)
        row = _get_request(request_id)
        return self._send(200, _public_view(row))


def main():
    if not APPROVER_TOKEN:
        print("portal: APPROVER_TOKEN is not set -- refusing to start", file=sys.stderr)
        return 1
    _init_db()
    print("portal listening on :%d (LITELLM_URL=%s, db=%s)" % (PORT, LITELLM_URL, DB_PATH), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
