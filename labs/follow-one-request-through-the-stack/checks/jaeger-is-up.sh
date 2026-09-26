#!/usr/bin/env bash
# Part 1 placeholder check: proves jaeger is genuinely up and the seed
# script's trace really landed (all 6 spans present). Part 2
# (answers-match-the-trace) is the graded check that compares the learner's
# answers.json against what that same trace actually shows.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" jaeger-is-up
