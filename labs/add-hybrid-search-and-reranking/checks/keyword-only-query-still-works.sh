#!/usr/bin/env bash
# Outcome-based: shares the same grader run as the other two checks (see
# _harness.py) -- checks the query whose right answer is distinguished
# from its sibling only by an exact error code.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" keyword-only-query-still-works
