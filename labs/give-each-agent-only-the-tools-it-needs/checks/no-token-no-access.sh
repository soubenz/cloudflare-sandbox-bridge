#!/usr/bin/env bash
# The anti-cheat for the OTHER two checks in a different direction: proves
# MCP_REQUIRE_AUTH is actually doing something. Without it, a call to a
# virtual server's own MCP endpoint would succeed with no token at all
# (this gateway sends no admin header on this probe, and still lets a
# tokenless call in unless MCP_REQUIRE_AUTH is on), which would make
# "refused" in the other two checks mean nothing. See _harness.py for the
# shared setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" no-token-no-access
