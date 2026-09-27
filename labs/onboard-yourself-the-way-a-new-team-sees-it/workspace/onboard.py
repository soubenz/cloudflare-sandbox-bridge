#!/usr/bin/env python3
"""Walk the real onboarding path a new team has to walk on this platform,
one real HTTP call at a time, timing every step.

    python3 -B onboard.py            # run every step, in order
    python3 -B onboard.py --step 3   # run just one step (1-5)
    python3 -B onboard.py --status   # print what's already been done, no calls

This is not a stub to fill in -- every function below already talks to the
real, running LiteLLM and ContextForge in this session (LITELLM_URL,
LITELLM_MASTER_KEY, CONTEXTFORGE_URL, WEATHER_TOOL_URL, all already in your
environment) and does something real on each run. The point of this lab is
running it and reading what happens: what each step actually costs in wall-
clock time, and how many separate systems a brand new team has to touch
before they can make a single real call.

Each step is idempotent (it looks for what it needs before creating
anything), so running the whole thing twice, or re-running one step on its
own, never breaks the next one -- and re-running is exactly how you'd
notice a step is slow: `python3 -B onboard.py --step 5` a second time still
does two real HTTP round trips, not a cached answer.

State (team id, the new key, the tool ids, the virtual server id) is kept
in onboard_state.json next to this file, purely so steps 2-5 don't have to
re-derive everything step 1 already found out. Delete it to start over
(nothing on the gateway itself is deleted -- the next run just finds the
same team/key/gateway/server again and reuses them, same as any of this
lab's seed scripts).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
WEATHER_TOOL_URL = os.environ.get("WEATHER_TOOL_URL", "http://127.0.0.1:7745/mcp")

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, "onboard_state.json")

# Fixed identifiers for the new team this lab has you onboard. Real names a
# platform team would pick, not placeholders -- every step below is a real
# call, and check_gateway_is_up.sh looks for exactly these to prove your
# onboarding actually happened, not just that the script ran.
NEW_TEAM_ID = "team-new-team"
NEW_TEAM_ALIAS = "new-team"
GRANTED_ALIAS = "fast-draft"          # the only alias this team ever gets
LEGACY_ALIAS = "legacy-writer"        # the platform's pre-existing alias -- never granted
TOOL_GATEWAY_NAME = "weather-tools"
VIRTUAL_SERVER_NAME = "new-team-tools"


# --------------------------------------------------------------- HTTP glue

def _litellm(method, path, body=None, timeout=15):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
    req = urllib.request.Request(
        LITELLM_URL + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method,
        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    return _send(req, timeout)


def _litellm_as(key, method, path, body=None, timeout=15):
    """Same as _litellm but authenticated as a caller's OWN key, not the
    master key -- this is what actually proves a key's boundary."""
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


def _find_by_name(list_status_body, name):
    status, body = list_status_body
    if status != 200 or not isinstance(body, list):
        return None
    for item in body:
        if item.get("name") == name:
            return item
    return None


# ------------------------------------------------------------------ state

def _load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except (ValueError, OSError):
            return {}
    return {}


def _save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
        f.write("\n")
    os.replace(tmp, STATE_FILE)


# ------------------------------------------------------------------ steps
#
# Every step function does real work against the live gateway/ContextForge
# and returns a short human-readable result string. Timing and printing are
# handled once, by run_step(), so every step reports the same way.

def step_1_create_team(state):
    """LiteLLM: create the new team, scoped to exactly one alias."""
    status, _ = _litellm("GET", "/team/info?team_id=%s" % NEW_TEAM_ID)
    if status == 200:
        state["team_id"] = NEW_TEAM_ID
        return "team %r already exists (re-run is idempotent)" % NEW_TEAM_ALIAS
    status, body = _litellm(
        "POST", "/team/new",
        {"team_id": NEW_TEAM_ID, "team_alias": NEW_TEAM_ALIAS, "models": [GRANTED_ALIAS]},
    )
    if status != 200:
        raise SystemExit("onboard: could not create team: %s %s" % (status, body))
    state["team_id"] = body["team_id"]
    return "created team %r, scoped to models=%s" % (NEW_TEAM_ALIAS, [GRANTED_ALIAS])


def step_2_create_key(state):
    """LiteLLM: a key for the new team. A key created with just a team_id
    inherits that team's `models` list -- it is never given a separate
    list of its own, so it can never drift from the team's."""
    existing_key = state.get("key")
    if existing_key:
        status, _ = _litellm("GET", "/key/info?key=%s" % existing_key)
        if status == 200:
            return "reusing the key already minted for %r" % NEW_TEAM_ALIAS
    status, body = _litellm(
        "POST", "/key/generate",
        {"team_id": state["team_id"], "key_alias": "%s-key" % NEW_TEAM_ALIAS},
    )
    if status != 200:
        raise SystemExit("onboard: could not create a key: %s %s" % (status, body))
    state["key"] = body["key"]
    return "minted a new key for %r (never printed again after this run)" % NEW_TEAM_ALIAS


def step_3_register_tool_server(state):
    """ContextForge: register the new team's own tool server as a gateway.
    weather-tools is a second, real toy MCP tool server this lab runs
    alongside calculator-tools (the one already registered before you
    started, as legacy-tools) -- nobody has registered it until this step
    does."""
    existing = _find_by_name(_contextforge("GET", "/v1/gateways"), TOOL_GATEWAY_NAME)
    if existing is not None:
        state["gateway_id"] = existing["id"]
        return "gateway %r already registered (re-run is idempotent)" % TOOL_GATEWAY_NAME
    status, body = _contextforge(
        "POST", "/v1/gateways",
        {
            "name": TOOL_GATEWAY_NAME,
            "url": WEATHER_TOOL_URL,
            "description": "the new team's own toy weather MCP tool server",
            "transport": "STREAMABLEHTTP",
        },
    )
    if status not in (200, 201):
        raise SystemExit("onboard: could not register the tool server: %s %s" % (status, body))
    state["gateway_id"] = body["id"]
    return "registered %r as a gateway (id=%s)" % (TOOL_GATEWAY_NAME, body["id"])


def step_4_expose_virtual_server(state):
    """ContextForge: expose the new team's tool(s) through one virtual
    server of their own. This IS the access grant in this lab -- ContextForge
    here runs unauthenticated (AUTH_REQUIRED=false, same as
    see-how-tools-reach-an-agent), so there is no separate per-key ACL call
    to make on this side; a tool reaches a caller by being in the virtual
    server they ask, and nowhere else. (LiteLLM's equivalent access grant
    already happened in step 1 -- a team's `models` list IS its grant.)"""
    existing = _find_by_name(_contextforge("GET", "/v1/servers"), VIRTUAL_SERVER_NAME)
    if existing is not None:
        state["server_id"] = existing["id"]
        return "virtual server %r already exists (re-run is idempotent)" % VIRTUAL_SERVER_NAME

    status, tools = _contextforge("GET", "/v1/tools/")
    if status != 200 or not isinstance(tools, list):
        raise SystemExit("onboard: could not list tools: %s %s" % (status, tools))
    tool_ids = [t["id"] for t in tools if t.get("gatewaySlug") == TOOL_GATEWAY_NAME]
    if not tool_ids:
        raise SystemExit("onboard: no tools found for gateway %r yet -- federation may still be in progress, try this step again" % TOOL_GATEWAY_NAME)

    status, body = _contextforge(
        "POST", "/v1/servers",
        {"server": {"name": VIRTUAL_SERVER_NAME, "description": "the new team's own virtual server", "associated_tools": tool_ids}},
    )
    if status not in (200, 201):
        raise SystemExit("onboard: could not create the virtual server: %s %s" % (status, body))
    state["server_id"] = body["id"]
    return "exposed %d tool(s) through virtual server %r (id=%s)" % (len(tool_ids), VIRTUAL_SERVER_NAME, body["id"])


def step_5_end_to_end_call(state):
    """The point of the whole exercise: one real call through the new key
    (LiteLLM), immediately followed by one real call through the new
    ContextForge access (the virtual server from step 4) -- and, along the
    way, a real proof that the new key is refused on the alias it was never
    granted. Three real HTTP round trips, two different systems."""
    key = state["key"]

    # (a) the boundary: this key must NOT reach the platform's pre-existing
    # alias. A real 403 here, not an assumption.
    status, _ = _litellm_as(
        key, "POST", "/chat/completions",
        {"model": LEGACY_ALIAS, "messages": [{"role": "user", "content": "onboarding probe"}]},
    )
    legacy_status = status
    print("    -> new key against %r (never granted): HTTP %s" % (LEGACY_ALIAS, legacy_status))

    # (b) the real call: this key against the alias it WAS granted.
    status, body = _litellm_as(
        key, "POST", "/chat/completions",
        {"model": GRANTED_ALIAS, "messages": [{"role": "user", "content": "What's the weather like in Paris?"}]},
    )
    print("    -> new key against %r (granted): HTTP %s" % (GRANTED_ALIAS, status))
    if status != 200:
        raise SystemExit("onboard: the new key was refused on its own granted alias: %s %s" % (status, body))
    reply = ((body.get("choices") or [{}])[0].get("message") or {}).get("content", "")
    print("    -> model replied: %r" % reply)

    # (c) the tool half: a real MCP call through the new virtual server.
    status, body = _contextforge(
        "POST", "/servers/%s/mcp" % state["server_id"],
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "weather-tools-get-weather", "arguments": {"city": "Paris"}}},
    )
    print("    -> new virtual server, weather-tools-get-weather: HTTP %s" % status)
    result = (body or {}).get("result") or {}
    tool_ok = status == 200 and not result.get("isError")
    if tool_ok:
        for item in result.get("content", []):
            if item.get("type") == "text":
                print("    -> tool replied: %s" % item["text"])
    else:
        raise SystemExit("onboard: the tool call through the new virtual server failed: %s" % (result.get("content") or body))

    if legacy_status not in (401, 403):
        raise SystemExit(
            "onboard: the new key was NOT refused on %r (got HTTP %s) -- something granted it more than it should have"
            % (LEGACY_ALIAS, legacy_status)
        )

    return "end-to-end call succeeded (LiteLLM call + ContextForge tool call), and the legacy alias was correctly refused (HTTP %s)" % legacy_status


STEPS = [
    (1, "create the new team's key, scoped to one alias (LiteLLM)", step_1_create_team),
    (2, "mint the team's key (LiteLLM)", step_2_create_key),
    (3, "register the new team's own tool server (ContextForge)", step_3_register_tool_server),
    (4, "expose it through the new team's own virtual server (ContextForge)", step_4_expose_virtual_server),
    (5, "make one real end-to-end call through both", step_5_end_to_end_call),
]


def run_step(n, label, fn, state):
    print("step %d/%d: %s" % (n, len(STEPS), label))
    start_wall = time.strftime("%H:%M:%S")
    t0 = time.time()
    result = fn(state)
    elapsed = time.time() - t0
    print("  [%s] %s  (%.3fs)" % (start_wall, result, elapsed))
    _save_state(state)
    return elapsed


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--step", type=int, choices=[n for n, _, _ in STEPS], help="run just this one step")
    parser.add_argument("--status", action="store_true", help="print saved state and exit, no HTTP calls")
    args = parser.parse_args()

    state = _load_state()

    if args.status:
        print(json.dumps(state, indent=2) if state else "(nothing recorded yet -- run onboard.py first)")
        return

    if not LITELLM_MASTER_KEY:
        sys.exit("onboard: LITELLM_MASTER_KEY is not set in your environment")

    total_start = time.time()
    if args.step:
        n, label, fn = next(s for s in STEPS if s[0] == args.step)
        run_step(n, label, fn, state)
    else:
        for n, label, fn in STEPS:
            run_step(n, label, fn, state)
    total = time.time() - total_start
    print()
    print("total wall-clock time for %s: %.3fs" % ("that step" if args.step else "the whole onboarding path", total))


if __name__ == "__main__":
    main()
