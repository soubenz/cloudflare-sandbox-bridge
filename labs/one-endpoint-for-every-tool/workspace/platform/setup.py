#!/usr/bin/env python3
"""Put every tool server behind one endpoint.

Run this any time platform/catalogue.yaml changes:

    python3 -B platform/setup.py

It should be safe to run more than once -- creating something that
already exists with the same shape is not an error you need to handle
specially for this lab (a gateway, virtual server, or token that already
exists can be left alone, updated in place, or replaced; any of those is
fine, as long as the end state matches catalogue.yaml and client.json
below is accurate afterwards).

Untouched, this file talks to nothing and writes platform/client.json with
every value blank -- so you can see the shape it is supposed to produce
before you've made any of it real.

What it has to leave behind, once it's done:

  - every tool server listed in catalogue.yaml's `tool_servers` is known
    to the gateway, and every tool it exposes is reachable *somewhere*
    through the gateway;
  - exactly ONE virtual server exists, bundling exactly the tools listed
    under `public_bundle` -- no more, no less. In particular, any tool a
    server exposes that is *not* listed there (see billing's own
    services/billing_server.py) must never end up in this bundle;
  - exactly one client token exists, scoped to that one virtual server and
    nothing else -- it must be refused for any tool outside the bundle,
    and refused for anything on the gateway that isn't that one virtual
    server's own tool-calling surface;
  - platform/client.json, in exactly this shape:
       {"virtual_server_id": "<the virtual server's id>",
        "virtual_server_name": "<its name>",
        "client_token": "<the scoped token's own usable secret>"}

The gateway's own base URL is in your environment as CONTEXTFORGE_URL --
never hard-code it. Each tool server's URL is in your environment too, one
env var per entry in `tool_servers` (e.g. the `inventory` entry's URL is
in INVENTORY_URL). The grader points these at its own copies of the same
three tool servers, running on different ports, so this script has to work
against whatever it's told, not just against what's running in your own
session.

You are the platform here, setting the gateway up before anyone else
touches it -- ContextForge's own admin surface needs no credential in this
session (see the manifest for why), so nothing above requires a bearer
token of its own. The one token this script DOES have to produce is the
client token above, and it must not be able to do anything the master
control plane can do.
"""

import json
import os
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOGUE_FILE = os.path.join(HERE, "catalogue.yaml")
CLIENT_FILE = os.path.join(HERE, "client.json")

# Never hard-code these -- the grader points them at its own instances.
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")


def load_catalogue():
    with open(CATALOGUE_FILE) as f:
        return yaml.safe_load(f) or {}


def main():
    catalogue = load_catalogue()
    tool_servers = catalogue.get("tool_servers") or []
    bundle = catalogue.get("public_bundle") or {}

    result = {
        "virtual_server_id": "",
        "virtual_server_name": bundle.get("name", ""),
        "client_token": "",
    }

    # TODO: register each server in tool_servers as a gateway (its URL is in
    # <NAME>_URL, e.g. INVENTORY_URL for the "inventory" entry), create the
    # one virtual server described by `public_bundle`, mint the one scoped
    # client token, and fill in `result` above with what actually happened.
    #
    # Nothing below this line talks to the gateway yet -- that's why running
    # this file as-is is safe and creates nothing.

    with open(CLIENT_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print("wrote %s" % CLIENT_FILE)


if __name__ == "__main__":
    sys.exit(main())
