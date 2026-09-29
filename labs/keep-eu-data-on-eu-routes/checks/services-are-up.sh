#!/usr/bin/env bash
# Sanity check: litellm and jaeger are up, both aliases exist, and every
# provider is healthy. Never the graded check.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" services-are-up
