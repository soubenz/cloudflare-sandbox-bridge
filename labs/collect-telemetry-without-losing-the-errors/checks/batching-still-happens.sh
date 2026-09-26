#!/usr/bin/env bash
# Confirms the collector is still batching spans before export (a real
# before/after count from otelcol's own telemetry, not a config grep) --
# see _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" batching-still-happens
