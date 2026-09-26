#!/usr/bin/env bash
# Outcome-based: fires a real request through the running gateway, polls
# the running Jaeger for the resulting trace id, and checks that spans from
# all three services (opalix-gateway, opalix-worker, opalix-storage) share
# it. See _harness.py for the shared setup this and the other two checks
# all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" one-trace-not-many
