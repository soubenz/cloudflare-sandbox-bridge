#!/usr/bin/env bash
# Outcome-based: shares one grading run's own probes with the other two
# checks. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" not-approved-tool-is-refused
