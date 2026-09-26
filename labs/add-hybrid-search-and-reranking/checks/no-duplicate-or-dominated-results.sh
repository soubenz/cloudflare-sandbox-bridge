#!/usr/bin/env bash
# Outcome-based: shares the same grader run as the other two checks (see
# _harness.py) -- checks (a) a query where the same document is a strong
# match on both signals appears exactly once, and (b) a query designed to
# expose a raw-score-scale bug ranks the true answer first, not the decoy
# with the bigger raw vector-similarity number.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" no-duplicate-or-dominated-results
