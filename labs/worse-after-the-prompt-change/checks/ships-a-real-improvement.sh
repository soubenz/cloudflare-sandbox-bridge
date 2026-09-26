#!/usr/bin/env bash
# Outcome-based: resets the judge and release services, runs the learner's
# own `run_gate.py` over a fixed candidate fixture, and grades what the
# release service recorded. The work lives in _harness.py, which all five
# graders share.
set -uo pipefail
PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo '{"pass": false, "message": "grader bug: no python3 on PATH inside the container"}'
  exit 1
fi
exec "$PY" "$HERE/_harness.py" ships-a-real-improvement
