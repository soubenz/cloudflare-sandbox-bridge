#!/usr/bin/env bash
# Outcome-based: shares one grading run's own probes (the learner's current
# egress/proxy.py and tools/*.py, run fresh on the grader's own ports) with
# the other two checks. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" approved-tool-is-reachable
