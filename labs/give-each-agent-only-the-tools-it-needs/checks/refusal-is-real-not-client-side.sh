#!/usr/bin/env bash
# The anti-cheat: stops the first check being satisfied the easy way --
# e.g. handing every role the SAME token/bundle, or quietly also scoping
# support-agent's own token to the admin server "just in case". Points
# each non-admin role's own token directly at the admin virtual server's
# server_id and confirms the gateway refuses it outright (401/403/tool-
# not-found), and confirms no role's token can list the platform's own
# gateways. See _harness.py for the shared setup this and the other two
# checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" refusal-is-real-not-client-side
