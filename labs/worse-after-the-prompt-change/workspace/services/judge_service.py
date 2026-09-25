#!/usr/bin/env python3
"""The judge -- the desk's model gateway, and the record of what a candidate
actually produced.

Every drafting call the gate makes goes through here. This service speaks
the OpenAI-compatible chat-completions shape, forwards the request to the
real model behind the session's AI Gateway, and -- this is the part that
matters for grading -- reads the reply back and writes down, as booleans,
whether it carried the policy reference, the escalation tag and the
disclosure line it was told to carry. That check happens here, once, in one
place, so that nothing calling this service ever has to read a reply as
prose: everything downstream reads three booleans and a policy id.

Four things worth knowing before you read the rest of this file:

1. This service holds no credential and needs none. $LLM_BASE_URL is the
   session's OpenAI-compatible endpoint and the Worker in front of it
   injects the token; the model name is $LLM_MODEL. See docs/spike.md.

2. MODEL_MODE=auto (the default) calls the real gateway and falls back to a
   fixed local reply table if it cannot be reached -- a lab must not fail a
   learner because a provider had a bad minute. Requests carry an explicit
   cf-aig-cache-key, so a repeated run is served from the gateway's cache;
   the explicit-key path needs two sequential repeats before it HITs, so an
   early MISS is normal.

3. The local reply table is not a random stand-in for a model. It is built
   so that each candidate's PROMPT_ID has a fixed, known reliability -- some
   fraction of calls come back missing the disclosure line or the
   escalation tag, on purpose, the same way a real prompt regression
   sometimes drops them under real sampling. Two fixed "variants" (set via
   POST /api/reset) move *which* call that happens on without moving *how
   often* it happens for a well-behaved candidate -- that is what makes
   this service able to test whether a gate's decision is stable under the
   kind of noise a live model actually produces, without this service's own
   behaviour ever being genuinely random. Nothing here reads as random
   between two runs with the same variant; that repeatability is what makes
   the graders able to trust their own verdicts.

4. It does not grade a gate's *decision*. It only grades, per call, whether
   what came back carried what it was told to carry. What a gate does with
   that information -- whether it ships or refuses, and why -- is between
   the gate and the release service.

The service runs as root from the lab manifest. Editing this file does not
change the running service; it is staged fresh at session start.
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

PORT = int(os.environ.get("JUDGE_PORT", "8901"))
POLICY_FILE = os.environ.get("POLICY_FILE", "/workspace/policy/index.json")

LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "")
MODEL_MODE = os.environ.get("MODEL_MODE", "auto").strip().lower()
UPSTREAM_ATTEMPTS = int(os.environ.get("UPSTREAM_ATTEMPTS", "2"))
UPSTREAM_TIMEOUT_S = float(os.environ.get("UPSTREAM_TIMEOUT_S", "45"))
CACHE_TTL_S = int(os.environ.get("MODEL_CACHE_TTL_S", "86400"))
MAX_COMPLETION_TOKENS = int(os.environ.get("MAX_COMPLETION_TOKENS", "220"))

ROUTES = ("/v1/chat/completions", "/api/calls", "/api/log", "/api/reset", "/healthz")

# --- the fixed reliability table --------------------------------------------
#
# Keyed by PROMPT_ID. "index_drops" fails one specific *case position*
# (1-based, as tagged by the caller's own metadata.case_index -- see
# gate/scoring.py) per variant, regardless of which candidate is being
# scored -- a fixed, occasional slip that is not tied to how hard that case
# is or to which candidate hit it. "hard_drops" fails every call whose
# customer message is past HARD_CASE_CHARS characters, regardless of
# variant or position -- a prompt that runs out of room to keep its
# instructions on long, detailed messages. An unknown PROMPT_ID (a
# candidate this table was never told about) never fails: this service
# does not penalise a candidate it cannot recognise. A call with no
# case_index in its metadata is only ever judged on length, never on
# position.
HARD_CASE_CHARS = int(os.environ.get("HARD_CASE_CHARS", "200"))

RELIABILITY = {
    "production-v18": {"index_drops": {"a": {7}, "b": {9}}, "hard_drops": False},
    "priority-v2": {"index_drops": {"a": set(), "b": set()}, "hard_drops": False},
    "trim-v3": {"index_drops": {"a": set(), "b": set()}, "hard_drops": True},
    "gamed-v1-clean": {"index_drops": {"a": set(), "b": set()}, "hard_drops": True},
    "gamed-v1-leaked": {"index_drops": {"a": set(), "b": set()}, "hard_drops": False},
}


def _should_drop(prompt_id, variant, case_index, message_len):
    profile = RELIABILITY.get(prompt_id)
    if profile is None:
        return False
    if case_index is not None and case_index in profile["index_drops"].get(variant, ()):
        return True
    if profile["hard_drops"] and message_len > HARD_CASE_CHARS:
        return True
    return False


# --- parsing the request -----------------------------------------------------

_PROMPT_ID_RE = re.compile(r"PROMPT_ID:\s*([A-Za-z0-9_.\-]+)")
_POLICY_RE = re.compile(r"Policy:\s*([A-Za-z0-9\-]+)")
_ESCALATE_RE = re.compile(r"escalates to:\s*([A-Za-z0-9_\-]+)", re.IGNORECASE)


def _load_policy():
    with open(POLICY_FILE, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _extract(messages):
    system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "") or ""
    user = next((m.get("content", "") for m in messages if m.get("role") == "user"), "") or ""
    prompt_id_match = _PROMPT_ID_RE.search(system)
    policy_match = _POLICY_RE.search(user)
    escalate_match = _ESCALATE_RE.search(user)
    message_line = ""
    if "Customer message:" in user:
        after = user.split("Customer message:", 1)[1]
        message_line = after.split("\n\n", 1)[0].strip()
    return {
        "prompt_id": prompt_id_match.group(1) if prompt_id_match else "unknown",
        "policy_id": policy_match.group(1) if policy_match else None,
        "escalate_to": escalate_match.group(1) if escalate_match else None,
        "message": message_line,
    }


# --- the local reply table ---------------------------------------------------


def _synthesize_reply(policy_id, escalate_to, disclosure, drop_required):
    body = "Thanks for writing in -- here is where things stand and what happens next."
    parts = [body]
    parts.append("Policy reference: %s." % (policy_id or "POL-02"))
    if not drop_required and escalate_to:
        parts.append("Escalated to: %s." % escalate_to)
    if not drop_required:
        parts.append(disclosure)
    return " ".join(parts)


def _cache_key(model, messages, max_tokens):
    canonical = json.dumps(
        {"model": model, "max_tokens": max_tokens,
         "messages": [{"role": m.get("role"), "content": m.get("content")} for m in messages]},
        sort_keys=True, separators=(",", ":"),
    )
    return "worse-after-the-prompt-change-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:40]


def _forward(messages, max_tokens):
    model = LLM_MODEL or "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8"
    body = json.dumps({
        "model": model,
        "messages": [{"role": m.get("role", "user"), "content": str(m.get("content") or "")} for m in messages],
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


def _ask_model(seq, messages, max_tokens, replay_text):
    """Real mode: try the gateway; MODEL_MODE=auto falls back to the fixed
    reply table (never to a real call) so the record this service keeps is
    the same fact regardless of which path answered. The live reply's exact
    wording is never checked against anything -- only the replay path's
    text is used to decide the required-elements booleans in *replay* runs;
    in live mode those booleans are read from whatever the real model said,
    which is the one place genuine model variance can show up.
    """
    if MODEL_MODE == "replay" or not LLM_BASE_URL:
        why = "MODEL_MODE=replay" if MODEL_MODE == "replay" else "no LLM_BASE_URL in the environment"
        return replay_text, "replay", "-", why

    last = ""
    for attempt in range(1, UPSTREAM_ATTEMPTS + 1):
        try:
            text, cache = _forward(messages, max_tokens)
            if text.strip():
                return text, "live", cache, ""
            last = "the gateway returned an empty reply"
        except urllib.error.HTTPError as err:
            last = "HTTP %d from the gateway" % err.code
        except Exception as err:  # noqa: BLE001
            last = "%s: %s" % (type(err).__name__, err)
        if attempt < UPSTREAM_ATTEMPTS:
            time.sleep(0.5 * attempt)

    if MODEL_MODE == "live":
        return None, "live", "-", last
    return replay_text, "replay", "-", last


# --- state --------------------------------------------------------------

_lock = threading.Lock()
_state = {"calls": [], "seq": 0, "variant": "a"}


def reset(variant):
    with _lock:
        _state["calls"] = []
        _state["seq"] = 0
        _state["variant"] = variant if variant in ("a", "b") else "a"


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def complete(payload):
    messages = payload.get("messages") or []
    max_tokens = int(payload.get("max_tokens") or MAX_COMPLETION_TOKENS)
    extracted = _extract(messages)
    policy = _load_policy()
    disclosure = policy["disclosure"]

    case_index = (payload.get("metadata") or {}).get("case_index")
    if not isinstance(case_index, int):
        case_index = None

    with _lock:
        _state["seq"] += 1
        seq = _state["seq"]
        variant = _state["variant"]

    drop = _should_drop(extracted["prompt_id"], variant, case_index, len(extracted["message"]))
    replay_text = _synthesize_reply(extracted["policy_id"], extracted["escalate_to"], disclosure, drop)

    text, mode, cache, note = _ask_model(seq, messages, max_tokens, replay_text)
    if not text:
        record = {
            "seq": seq, "variant": variant, "prompt_id": extracted["prompt_id"],
            "policy_id": extracted["policy_id"], "escalate_to": extracted["escalate_to"],
            "message_len": len(extracted["message"]), "case_index": case_index,
            "policy_ref_present": False, "escalation_present": False, "disclosure_present": False,
            "all_required_present": False, "outcome": "upstream_error", "mode": mode, "cache": cache,
            "note": note, "at": _now(),
        }
        with _lock:
            _state["calls"].append(record)
        return 502, {"error": {"message": "the gateway did not answer: %s" % note, "type": "server_error"}}

    policy_ref_present = bool(extracted["policy_id"]) and ("Policy reference: %s" % extracted["policy_id"]) in text
    escalation_present = (not extracted["escalate_to"]) or (
        ("Escalated to: %s" % extracted["escalate_to"]) in text
    )
    disclosure_present = disclosure in text
    all_present = policy_ref_present and escalation_present and disclosure_present

    record = {
        "seq": seq, "variant": variant, "prompt_id": extracted["prompt_id"],
        "policy_id": extracted["policy_id"], "escalate_to": extracted["escalate_to"],
        "message_len": len(extracted["message"]), "case_index": case_index,
        "policy_ref_present": policy_ref_present, "escalation_present": escalation_present,
        "disclosure_present": disclosure_present, "all_required_present": all_present,
        "outcome": "answered", "mode": mode, "cache": cache, "note": note, "at": _now(),
    }
    with _lock:
        _state["calls"].append(record)

    return 200, {
        "id": "chatcmpl-judge-%d" % seq,
        "object": "chat.completion",
        "model": payload.get("model") or LLM_MODEL,
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text}}],
        "usage": {"prompt_tokens": 0, "completion_tokens": max(1, len(text) // 4)},
    }


def snapshot():
    with _lock:
        calls = list(_state["calls"])
        variant = _state["variant"]
    total = len(calls)
    ok = sum(1 for c in calls if c["all_required_present"])
    return {
        "totals": {
            "calls": total,
            "all_required_present": ok,
            "score": (ok / total) if total else None,
            "variant": variant,
            "mode": MODEL_MODE,
            "model": LLM_MODEL or "(none configured)",
        },
        "calls": calls,
    }


PAGE = b"not exposed"


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-judge/1.0"

    def log_message(self, fmt, *args):
        print("judge %s - %s" % (self.address_string(), fmt % args), flush=True)

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
            return self._send(200, {"ok": True, "service": "judge"})
        if route in ("/api/log", "/api/calls"):
            return self._send(200, snapshot())
        return self._send(200, PAGE, "text/plain; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8", "replace") or "{}")
        except ValueError:
            payload = {}

        if route == "/api/reset":
            reset(payload.get("variant") or "a")
            return self._send(200, {"ok": True, "variant": _state["variant"]})
        if route != "/v1/chat/completions":
            return self._send(404, {"error": {"message": "no such endpoint: %s" % self.path}})

        status, body = complete(payload)
        try:
            self._send(status, body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    print(
        "judge service listening on :%d (mode %s, model %s, upstream %s)"
        % (PORT, MODEL_MODE, LLM_MODEL or "-", LLM_BASE_URL or "(none configured; replies come from the local table)"),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
