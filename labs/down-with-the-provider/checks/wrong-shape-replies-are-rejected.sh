#!/usr/bin/env bash
# A 200 whose body is the wrong shape is rejected, and the filing says what was wrong.
#
# Outcome-based: resets the two lab services, runs the learner's own
# `run_agent.py` over the lab queue, and grades what the services recorded.
# The work lives in _harness.py, which all three graders share.
set -uo pipefail
PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo '{"pass": false, "message": "grader bug: no python3 on PATH inside the container"}'
  exit 1
fi
exec "$PY" "$HERE/_harness.py" wrong-shape-replies-are-rejected
