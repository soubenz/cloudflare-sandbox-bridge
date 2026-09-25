#!/usr/bin/env bash
# Ordinary programs still run inside the boundary and still come back with the right answers.
#
# Outcome-based: resets the two lab services, feeds a battery of programs to
# the learner's own `run_tool.py`, and grades what the services recorded. The
# work lives in _harness.py, which all three graders share; the programs live
# in _battery.py, which the learner never sees.
set -uo pipefail
PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo '{"pass": false, "message": "grader bug: no python3 on PATH inside the container"}'
  exit 1
fi
# -B: the harness imports _battery, and a __pycache__ in the staging directory
# is litter in a directory that exists for one run.
exec "$PY" -B "$HERE/_harness.py" real-programs-still-run
