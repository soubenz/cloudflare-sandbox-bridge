#!/usr/bin/env bash
# Grafana must report a healthy database through its sub-path root_url.
set -uo pipefail
BASE="${GRAFANA_URL:-http://127.0.0.1:3001}"
body=$(curl -fsS --max-time 10 "$BASE/api/health" 2>/dev/null) || {
  echo '{"pass": false, "message": "grafana /api/health unreachable at $GRAFANA_URL"}'
  exit 1
}
case "$body" in
  *'"database": "ok"'*|*'"database":"ok"'*) echo '{"pass": true, "message": "grafana healthy"}'; exit 0 ;;
  *) echo "{\"pass\": false, \"message\": \"grafana unhealthy: ${body:0:180}\"}"; exit 1 ;;
esac
