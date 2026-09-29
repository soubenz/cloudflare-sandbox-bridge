#!/usr/bin/env bash
# The check that actually exercises the planted bypass: a request whose
# Host header names the approved tool but whose request line (the proxy's
# real connection target) names the not-approved service. Refused on a
# correct proxy, let through on the shipped skeleton. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" host-header-cannot-smuggle-a-destination
