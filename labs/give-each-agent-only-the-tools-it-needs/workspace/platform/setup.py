#!/usr/bin/env python3
"""Reconcile ContextForge with platform/roles.yaml.

Run this any time roles.yaml changes:

    python3 -B platform/setup.py

Right now, every tool on this gateway -- including the one admin-only
tool, accounts-tools-delete-account -- lives in a single virtual server,
"ungoverned-bundle", and the one token bootstrap_ungoverned.py handed out
for it can reach every one of them. (Try it: platform/ungoverned_token.txt
has that token. Nothing about it is a secret you're not meant to see --
seeing exactly how much it can reach is the point.) That bundle is not
yours to fix by deleting or editing it; it can keep existing, or not, once
you're done -- what has to be true afterwards is that NO ROLE'S OWN TOKEN
can reach anything outside that role's own list in roles.yaml, regardless
of what else still exists on the gateway.

What this script has to leave behind, for every role in roles.yaml:

  - exactly one virtual server on ContextForge, exposing exactly that
    role's own tools -- not more, not fewer, and never the tools listed
    only under a different role;
  - one token whose own scope keeps it bound to that one virtual server,
    so that even a caller who somehow learns another role's virtual
    server id cannot use this token to reach it;
  - platform/keys.json, in exactly this shape:
       {"roles": {"support-agent": "<token>", "ops-agent": "<token>",
                  "admin": "<token>"}}

"Refused" has to mean the gateway itself says so -- a 401/403, or a
same-shaped-but-still-real refusal like a resolution failure on a tool
that was simply never associated with the server the caller's token is
scoped to -- never something a client-side wrapper decides not to send.

Two facts worth knowing before you reach for curl:

  - ContextForge's admin/management API (the calls that create things --
    gateways, virtual servers, tokens) needs no login in this lab
    (AUTH_REQUIRED=false, ALLOW_UNAUTHENTICATED_ADMIN=true): an
    unauthenticated call is answered as admin@example.com. That is a
    different surface from the one that actually calls a tool
    (/servers/{id}/mcp), which does require a real token -- two different
    rules for two different surfaces, not a contradiction.
  - Every tool from all three tool servers is already registered as a
    gateway on this ContextForge (bootstrap_ungoverned.py did that before
    you ever opened this file) -- what you're missing is which tools ended
    up with which registered names and ids. $CONTEXTFORGE_URL's own admin
    UI, or a plain GET against its tools listing, will tell you; nothing
    in roles.yaml or this file hard-codes that mapping for you.

It should be safe to run this more than once -- creating something that
already exists with the same shape is not an error you need to handle
specially for this lab, as long as the end state matches roles.yaml and
keys.json is accurate afterwards.

Untouched, this file does nothing to the gateway and writes
platform/keys.json with every value blank -- so you can see the shape
it's supposed to produce before you've made any of it real.
"""

import json
import os
import sys
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROLES_FILE = os.path.join(HERE, "roles.yaml")
KEYS_FILE = os.path.join(HERE, "keys.json")

# ContextForge's own base URL -- never hard-code it. A later grader points
# this at a different, freshly-seeded ContextForge than the one you've
# been testing against, so this script has to work against whatever it's
# told, not just against your own session's gateway.
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")


def _request(method, path, body=None, token=None):
    """Minimal JSON HTTP helper. Returns (status, parsed_body_or_text).

    Never raises on a non-2xx response -- ContextForge answers plenty of
    deliberate 401s/403s/422s, and those are data, not exceptions.
    """
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer %s" % token
    req = urllib.request.Request(CONTEXTFORGE_URL + path, data=data, method=method, headers=headers)
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


def load_roles():
    with open(ROLES_FILE) as f:
        return (yaml.safe_load(f) or {}).get("roles", {}) or {}


def main():
    roles = load_roles()
    result = {"roles": {name: "" for name in roles}}

    # TODO: for each role in `roles` (each one's `tools` list is
    # [{"server": ..., "tool": ...}, ...] straight from roles.yaml), work
    # out what ContextForge actually calls each of those tools once
    # registered, create that role's own virtual server exposing exactly
    # that set, mint a token scoped to it, and fill in `result` above.
    #
    # Nothing below this line talks to ContextForge yet -- that's why
    # running this file as-is is safe and creates nothing.

    with open(KEYS_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print("wrote %s" % KEYS_FILE)


if __name__ == "__main__":
    sys.exit(main())
