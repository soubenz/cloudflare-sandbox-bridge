#!/usr/bin/env bash
# Outcome-based: Prometheus must be ready AND actually scraping (up == 1),
# which only holds if the config, TSDB and route prefix are all correct.
set -uo pipefail
BASE="${PROM_URL:-http://127.0.0.1:9090}"

if ! curl -fsS --max-time 5 "$BASE/-/ready" >/dev/null 2>&1; then
  echo '{"pass": false, "message": "prometheus is not ready at $PROM_URL"}'
  exit 1
fi

body=$(curl -fsS --max-time 10 "$BASE/api/v1/query?query=up%7Bjob%3D%22prometheus%22%7D" 2>/dev/null)
case "$body" in
  *'"status":"success"'*) ;;
  *) echo "{\"pass\": false, \"message\": \"query api did not succeed: ${body:0:180}\"}"; exit 1 ;;
esac
case "$body" in
  *'"1"'*) echo '{"pass": true, "message": "prometheus ready and its self-scrape is up"}'; exit 0 ;;
  *) echo "{\"pass\": false, \"message\": \"prometheus is up but its scrape target is down: ${body:0:180}\"}"; exit 1 ;;
esac
