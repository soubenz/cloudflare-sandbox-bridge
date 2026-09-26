#!/usr/bin/env bash
# Outcome-based: shares the same grader run as bundle-reaches-exactly-its-tools.
# See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" excluded-tool-stays-out
