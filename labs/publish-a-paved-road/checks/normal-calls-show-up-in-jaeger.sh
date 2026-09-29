#!/usr/bin/env bash
# Outcome-based: shares one grading run's shared probes (see _harness.py).
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" normal-calls-show-up-in-jaeger
