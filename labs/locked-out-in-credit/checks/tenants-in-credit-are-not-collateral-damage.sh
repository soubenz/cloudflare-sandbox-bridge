#!/usr/bin/env bash
# Outcome-based: resets the ledger service, runs the learner's own
# `run_traffic.py` over the lab traffic, and grades what the ledger
# recorded. The work lives in _harness.py, which all three graders share.
set -uo pipefail
PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo '{"pass": false, "message": "grader bug: no python3 on PATH inside the container"}'
  exit 1
fi
exec "$PY" "$HERE/_harness.py" tenants-in-credit-are-not-collateral-damage
