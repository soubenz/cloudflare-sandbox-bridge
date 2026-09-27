#!/usr/bin/env python3
"""Shared grader for this lab's two checks.

Never reads workspace/onboard.py or workspace/answers.json's history --
every fact this file grades on comes from real HTTP calls this script makes
itself, live, against the SAME running LiteLLM and ContextForge this
session's `view` tab and `onboard.py` talk to (LITELLM_URL,
LITELLM_MASTER_KEY, CONTEXTFORGE_URL, WEATHER_TOOL_URL -- all manifest-level
env, so a check script sees them per docs/lab-authoring.md).

It re-derives the platform's real onboarding path under its OWN names
(team-grader-onboarding / grader-onboarding-tools, never
team-new-team / new-team-tools), so nothing here depends on the learner
having run onboard.py at all, on what they renamed anything to, or on
whether their own onboarding attempt is still in whatever state they left
it. Idempotent by lookup-first, same pattern as every seed script and
onboard.py itself, so re-running a check twice in the same session changes
nothing and costs almost nothing the second time.

Every probe result is a plain fact recorded once (an HTTP status, a
boolean); the two check scripts each apply their own pass/fail reading of
the same facts. No fresh database, no second LiteLLM/ContextForge process:
this lab has nothing to reconcile or rebuild, only live services to ask.
"""

import json
import os
import sys
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
WEATHER_TOOL_URL = os.environ.get("WEATHER_TOOL_URL", "http://127.0.0.1:7745/mcp")
ANSWERS_PATH = os.environ.get("ANSWERS_FILE", "/workspace/answers.json")

# The platform's own pre-existing facts (seed_litellm.py / seed_contextforge.py).
LEGACY_ALIAS = "legacy-writer"
LEGACY_TEAM_ID = "team-platform-core"
GRANTED_ALIAS = "fast-draft"
EXISTING_TOOL_GATEWAY = "calculator-tools"
EXISTING_VIRTUAL_SERVER = "legacy-tools"

# The grader's own onboarding run -- distinct names from onboard.py's, on
# purpose (see module docstring).
GRADER_TEAM_ID = "team-grader-onboarding"
GRADER_TEAM_ALIAS = "grader-onboarding"
GRADER_TOOL_GATEWAY = "weather-tools"  # reused if onboard.py already made it; created if not
GRADER_VIRTUAL_SERVER = "grader-onboarding-tools"

REQUIRED_ANSWER_KEYS = (
    "systems_touched_end_to_end",
    "new_key_reaches_legacy_alias",
    "end_to_end_call_succeeded",
)


# ---------------------------------------------------------------- HTTP glue

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _send(req, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def _litellm(method, path, key, body=None, timeout=15):
    req = urllib.request.Request(
        LITELLM_URL + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method,
        headers={"Authorization": "Bearer %s" % key},
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    return _send(req, timeout)


def _contextforge(method, path, body=None, timeout=15):
    req = urllib.request.Request(
        CONTEXTFORGE_URL + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method,
        headers={"Accept": "application/json, text/event-stream"},
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    return _send(req, timeout)


def _find_by_name(status_body, name):
    status, body = status_body
    if status != 200 or not isinstance(body, list):
        return None
    for item in body:
        if item.get("name") == name:
            return item
    return None


# ------------------------------------------------------------ the re-derivation

def _build_truth():
    """Runs the real onboarding sequence itself, under grader-owned names,
    against the live services, and records every fact needed to grade the
    three answers plus the boot-sanity check. Never raises on an
    infrastructure hiccup -- returns {"error": ...} instead, so a check can
    fail with a clear message rather than a traceback."""
    truth = {"error": None, "systems": set()}

    # --- sanity: both gateways are actually up, and the pre-existing
    # ("today, before this new team arrived") state is really there. ---
    status, _ = _litellm("GET", "/health/readiness", LITELLM_MASTER_KEY)
    if status != 200:
        truth["error"] = "LiteLLM /health/readiness returned %r, expected 200" % status
        return truth
    truth["systems"].add("litellm")

    status, _ = _litellm("GET", "/team/info?team_id=%s" % LEGACY_TEAM_ID, LITELLM_MASTER_KEY)
    truth["legacy_team_exists"] = (status == 200)

    status, _ = _contextforge("GET", "/health")
    if status != 200:
        truth["error"] = "ContextForge /health returned %r, expected 200" % status
        return truth
    truth["systems"].add("contextforge")

    existing_gw = _find_by_name(_contextforge("GET", "/v1/gateways"), EXISTING_TOOL_GATEWAY)
    truth["legacy_gateway_exists"] = existing_gw is not None
    existing_srv = _find_by_name(_contextforge("GET", "/v1/servers"), EXISTING_VIRTUAL_SERVER)
    truth["legacy_server_exists"] = existing_srv is not None

    # --- re-derive the onboarding path, end to end, under the grader's own
    # names (see module docstring for why: independence from the learner's
    # own onboard.py run). ---

    # 1. the new team, scoped to exactly one alias.
    status, _ = _litellm("GET", "/team/info?team_id=%s" % GRADER_TEAM_ID, LITELLM_MASTER_KEY)
    if status != 200:
        status, body = _litellm(
            "POST", "/team/new", LITELLM_MASTER_KEY,
            {"team_id": GRADER_TEAM_ID, "team_alias": GRADER_TEAM_ALIAS, "models": [GRANTED_ALIAS]},
        )
        if status != 200:
            truth["error"] = "could not create the grader's own onboarding team: %s %s" % (status, body)
            return truth
    truth["systems"].add("litellm")

    # 2. a key for it. Deliberately no key_alias: LiteLLM requires key
    # aliases to be unique gateway-wide, and this check mints a fresh key
    # on every run (it never reuses one from a previous run -- LiteLLM
    # never returns a key's plaintext again after creation, so there is
    # nothing to reuse), so a fixed alias would collide with itself on the
    # second run in the same session.
    status, body = _litellm(
        "POST", "/key/generate", LITELLM_MASTER_KEY,
        {"team_id": GRADER_TEAM_ID},
    )
    if status != 200:
        truth["error"] = "could not mint a key for the grader's onboarding team: %s %s" % (status, body)
        return truth
    grader_key = body["key"]
    truth["systems"].add("litellm")

    # 3. register the tool server (reused if onboard.py already did this --
    # same real tool server either way).
    gw = _find_by_name(_contextforge("GET", "/v1/gateways"), GRADER_TOOL_GATEWAY)
    if gw is None:
        status, body = _contextforge(
            "POST", "/v1/gateways",
            {"name": GRADER_TOOL_GATEWAY, "url": WEATHER_TOOL_URL, "description": "grader probe", "transport": "STREAMABLEHTTP"},
        )
        if status not in (200, 201):
            truth["error"] = "could not register the grader's own tool gateway: %s %s" % (status, body)
            return truth
    truth["systems"].add("contextforge")

    # 4. the grader's own virtual server, independent of whatever the
    # learner named theirs.
    srv = _find_by_name(_contextforge("GET", "/v1/servers"), GRADER_VIRTUAL_SERVER)
    if srv is None:
        status, tools = _contextforge("GET", "/v1/tools/")
        if status != 200 or not isinstance(tools, list):
            truth["error"] = "could not list ContextForge tools: %s %s" % (status, tools)
            return truth
        tool_ids = [t["id"] for t in tools if t.get("gatewaySlug") == GRADER_TOOL_GATEWAY]
        if not tool_ids:
            truth["error"] = "no tools found for gateway %r -- federation may still be in progress" % GRADER_TOOL_GATEWAY
            return truth
        status, body = _contextforge(
            "POST", "/v1/servers",
            {"server": {"name": GRADER_VIRTUAL_SERVER, "description": "grader probe", "associated_tools": tool_ids}},
        )
        if status not in (200, 201):
            truth["error"] = "could not create the grader's own virtual server: %s %s" % (status, body)
            return truth
        server_id = body["id"]
    else:
        server_id = srv["id"]
    truth["systems"].add("contextforge")

    # --- the three graded facts, each a real call this run makes itself ---

    # (a) does this freshly-scoped key reach the platform's pre-existing,
    # never-granted alias?
    status, _ = _litellm(
        "POST", "/chat/completions", grader_key,
        {"model": LEGACY_ALIAS, "messages": [{"role": "user", "content": "grader probe"}]},
    )
    truth["reaches_legacy_alias"] = (status == 200)
    truth["legacy_alias_status"] = status
    if status in (200,) or status in (401, 403):
        truth["systems"].add("litellm")  # a real, meaningful answer either way

    # (b) the LLM half of the real end-to-end call.
    status, body = _litellm(
        "POST", "/chat/completions", grader_key,
        {"model": GRANTED_ALIAS, "messages": [{"role": "user", "content": "grader end-to-end probe"}]},
    )
    llm_ok = (status == 200 and isinstance(body, dict) and body.get("choices"))
    truth["llm_call_status"] = status
    if status == 200:
        truth["systems"].add("litellm")

    # (c) the tool half of the real end-to-end call.
    status, body = _contextforge(
        "POST", "/servers/%s/mcp" % server_id,
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "%s-get-weather" % GRADER_TOOL_GATEWAY, "arguments": {"city": "Berlin"}}},
    )
    result = (body or {}).get("result") or {}
    tool_ok = (status == 200 and not result.get("isError"))
    truth["tool_call_status"] = status
    if status == 200:
        truth["systems"].add("contextforge")

    truth["end_to_end_ok"] = bool(llm_ok and tool_ok)
    truth["systems_touched_count"] = len(truth["systems"])
    return truth


_CACHED = None


def get_truth():
    global _CACHED
    if _CACHED is None:
        _CACHED = _build_truth()
    return _CACHED


# ------------------------------------------------------------- the checks

def check_stack_is_up():
    """Proves the stack genuinely boots and serves, and that the
    'platform as it exists today' pre-seeded state is really there --
    the equivalent of see-how-tools-reach-an-agent's gateway-is-up."""
    truth = get_truth()
    if truth.get("error"):
        _finish(False, truth["error"])
    if not truth.get("legacy_team_exists"):
        _finish(False, "the pre-existing team %r is missing -- has seed_litellm.py run?" % LEGACY_TEAM_ID)
    if not truth.get("legacy_gateway_exists"):
        _finish(False, "the pre-existing tool gateway %r is missing -- has seed_contextforge.py run?" % EXISTING_TOOL_GATEWAY)
    if not truth.get("legacy_server_exists"):
        _finish(False, "the pre-existing virtual server %r is missing -- has seed_contextforge.py run?" % EXISTING_VIRTUAL_SERVER)
    if not truth.get("end_to_end_ok"):
        _finish(False, "a real onboarding-shaped call (new key, granted alias, own tool) did not succeed end-to-end -- llm_call_status=%r tool_call_status=%r" % (truth.get("llm_call_status"), truth.get("tool_call_status")))
    _finish(True, "LiteLLM and ContextForge are both up, the pre-existing platform-core team and legacy-tools server are in place, and a fresh onboarding-shaped call succeeds end-to-end")


def _load_answers():
    if not os.path.isfile(ANSWERS_PATH):
        return None, "answers.json not found at %s" % ANSWERS_PATH
    try:
        with open(ANSWERS_PATH) as f:
            raw = f.read()
    except OSError as e:
        return None, "could not read %s: %s" % (ANSWERS_PATH, e)
    try:
        data = json.loads(raw)
    except ValueError as e:
        return None, "answers.json is not valid JSON: %s" % e
    if not isinstance(data, dict):
        return None, "answers.json must be a JSON object"
    return data, None


def _norm_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _norm_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value == 1:
            return True
        if value == 0:
            return False
        return None
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("true", "yes", "1"):
            return True
        if s in ("false", "no", "0"):
            return False
    return None


def check_answers_match_the_live_onboarding():
    answers, err = _load_answers()
    if err:
        _finish(False, err)

    missing = [k for k in REQUIRED_ANSWER_KEYS if answers.get(k) is None]
    if missing:
        _finish(False, "answers.json is missing an answer for: %s" % ", ".join(missing))

    truth = get_truth()
    if truth.get("error"):
        _finish(False, "could not verify your answers: %s" % truth["error"])

    got_systems = _norm_number(answers.get("systems_touched_end_to_end"))
    if got_systems is None or got_systems != float(truth["systems_touched_count"]):
        _finish(False, "systems_touched_end_to_end does not match how many distinct systems a real onboarding run just touched (%d)" % truth["systems_touched_count"])

    got_reaches = _norm_bool(answers.get("new_key_reaches_legacy_alias"))
    if got_reaches is None or got_reaches != truth["reaches_legacy_alias"]:
        _finish(False, "new_key_reaches_legacy_alias does not match what a freshly-scoped key actually gets back from %r right now (HTTP %r)" % (LEGACY_ALIAS, truth.get("legacy_alias_status")))

    got_e2e = _norm_bool(answers.get("end_to_end_call_succeeded"))
    if got_e2e is None or got_e2e != truth["end_to_end_ok"]:
        _finish(False, "end_to_end_call_succeeded does not match whether a real call through a new key and a new tool registration actually succeeds right now")

    _finish(True, "all three answers match what a live, freshly-run onboarding sequence actually reports right now")


COMMANDS = {
    "stack-is-up": check_stack_is_up,
    "answers-match-the-live-onboarding": check_answers_match_the_live_onboarding,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
