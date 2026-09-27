#!/usr/bin/env bash
# Part 1 placeholder check: proves litellm and jaeger are genuinely up and
# that all three regional aliases report a live region in their own
# model_info. Part 2 (answers-match-live-traces) is the graded check.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" services-are-up
