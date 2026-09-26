#!/usr/bin/env bash
# Outcome-based: proves the 'support' alias actually reaches deployment a
# through LiteLLM, not just that config.yaml says so -- resets the
# provider's log, makes one real call through the gateway, then checks the
# provider's own record of what it received.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" alias-routes
