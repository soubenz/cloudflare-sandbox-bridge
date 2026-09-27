#!/usr/bin/env bash
# Outcome-based: fires two real requests through the already-running
# gateway (support-us, support-eu), derives the true answer to each of the
# brief's three questions from those calls' own real traces in jaeger and
# their own real rows in LiteLLM's spend log, and compares them against
# /workspace/answers.json.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" answers-match-live-traces
