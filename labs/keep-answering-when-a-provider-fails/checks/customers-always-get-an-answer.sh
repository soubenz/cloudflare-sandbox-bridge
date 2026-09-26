#!/usr/bin/env bash
# Outcome-based: shares one grading run's own traffic (a fresh LiteLLM
# against the learner's current gateway/config.yaml, driven through an
# outage and back) with the other three checks. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" customers-always-get-an-answer
