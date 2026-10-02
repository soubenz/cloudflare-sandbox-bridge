#!/usr/bin/env bash
# Outcome-based: the learner's own `run_traffic.py` is run once per grading
# run and all three checks read its result. See _harness.py.
set -uo pipefail
PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo '{"pass": false, "message": "grader bug: no python3 on PATH in this lab"}'
  exit 1
fi
exec "$PY" -B "$HERE/_harness.py" no-tenant-spends-past-its-own-budget
