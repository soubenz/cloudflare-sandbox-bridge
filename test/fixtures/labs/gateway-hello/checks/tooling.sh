#!/usr/bin/env bash
# The gateway image is meant to carry LiteLLM, locust, Grafana, Prometheus
# and tmux. Assert each is executable, not merely on disk.
set -uo pipefail
missing=""
for tool in litellm locust tmux; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
[ -x /opt/prometheus/prometheus ] || missing="$missing prometheus"
[ -x /usr/sbin/grafana-server ] || missing="$missing grafana-server"

if [ -n "$missing" ]; then
  echo "{\"pass\": false, \"message\": \"missing from image:${missing}\"}"
  exit 1
fi
echo '{"pass": true, "message": "litellm, locust, tmux, prometheus and grafana-server all present"}'
