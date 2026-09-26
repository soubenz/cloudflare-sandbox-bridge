#!/usr/bin/env python3
"""Skeleton for YOUR staged-rollout and rollback discipline.

ContextForge itself has no rollout feature -- no canary, no percentage
traffic split, no built-in history table. What it does have, for real:

  * a gateway registration is a separate, independently-addressable thing
    (POST /v1/gateways) -- registering price-tool-v2 does not touch
    price-tool-v1's registration at all.
  * a tool's `enabled` flag (POST /v1/tools/{id}/state?activate=...) is a
    real kill switch: a disabled tool disappears from tools/list and
    refuses tools/call with a clear "is inactive" error.
  * a virtual server's `associated_tools` (PUT /v1/servers/{id}) is a
    single field you can overwrite in one call -- that single call is
    your cutover.
  * GET /v1/export and POST /v1/import move a whole config snapshot in
    and out.

state.yaml (written by ../contextforge/seed.py, in this same directory)
is YOUR bookkeeping: it names the one stable server_id every caller talks
to, records which tool id is v1 and (once you've registered it) which is
v2, and tracks `live_version`. Nothing updates it for you after seed.py's
first write -- that is your job, every time you change what is live, so
that a rollback has something correct to read.

The functions below are the shape of the job, not the job done. Fill in
each TODO. Nothing here calls ContextForge for you.
"""
import json
import os

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.yaml")
SNAPSHOTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshots")


def load_state():
    with open(STATE_PATH) as f:
        text = f.read()
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]
    return json.loads("\n".join(lines))


def save_state(state):
    with open(STATE_PATH, "w") as f:
        f.write("# Updated by rollout.py.\n")
        json.dump(state, f, indent=2)
        f.write("\n")


def register_v2():
    """Register price-tool-v2 (already running on port 65102, see
    ../services/tool_server.py) as its OWN gateway -- a distinct,
    separately-addressable registration, alongside v1's, not a change to
    v1's. Wait for its tool to be discovered, then record its gateway id
    and tool id into state.yaml (v2_gateway_id, v2_tool_id).

    Do NOT associate it with the "price-lookup" server yet -- that is the
    cutover step below, done deliberately, not as a side effect of
    registering.
    """
    raise NotImplementedError


def snapshot():
    """Take a timestamped export of the current ContextForge config (GET
    /v1/export) and save it under SNAPSHOTS_DIR. Record its path into
    state.yaml (last_snapshot_path) so a later rollback knows where to
    look. Do this BEFORE any change you're not sure of yet.
    """
    raise NotImplementedError


def cutover_to(version):
    """Make `version` ("v1" or "v2") the one tool associated with the
    stable "price-lookup" server -- and update state.yaml's
    `live_version` to match, so your own bookkeeping never disagrees with
    what ContextForge is actually serving.

    Think about whether this should be one API call or several -- and
    what a caller could observe if it's several.
    """
    raise NotImplementedError


def rollback():
    """Get back to a known-good state, fast, using last_snapshot_path (or
    whatever else state.yaml has recorded) -- and without changing the
    server_id callers already depend on.

    Whole-config import (POST /v1/import) is a real primitive. Prove to
    yourself, against this actual running ContextForge, whether importing
    your snapshot back over a server that already exists does what you'd
    expect it to -- for the one field that matters here.
    """
    raise NotImplementedError


if __name__ == "__main__":
    import sys

    COMMANDS = {"register-v2": register_v2, "snapshot": snapshot, "rollback": rollback}
    if len(sys.argv) == 3 and sys.argv[1] == "cutover":
        cutover_to(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] in COMMANDS:
        COMMANDS[sys.argv[1]]()
    else:
        print("usage: rollout.py {register-v2|snapshot|rollback|cutover v1|cutover v2}")
        raise SystemExit(2)
