#!/usr/bin/env bash
# Wait until both container applications report active/ready in
# `wrangler containers list`. `wrangler deploy --containers-rollout=immediate`
# returns before Cloudflare finishes rolling out (docs/spike.md, "A deploy
# lesson"), and a pool drain inside that window refills on the old image.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
set -uo pipefail

APPS=(opalix-sandbox-agentlab opalix-sandbox-gatewaylab)
INTERVAL="${ROLLOUT_INTERVAL:-15}"
DEADLINE=$(( $(date +%s) + ${ROLLOUT_TIMEOUT:-600} ))

# The list output is a box-drawn table; a row looks like
# │ <id> │ opalix-sandbox-agentlab │ ... │ active │ ...
# so match the app name and look for the state word anywhere in that row.
row_ready() {
  grep -F -- "$2" <<<"$1" | grep -Eiq '(^|[^[:alnum:]_-])(active|ready)([^[:alnum:]_-]|$)'
}

while true; do
  table="$(npx wrangler containers list 2>&1)" || true
  all_ready=1
  for app in "${APPS[@]}"; do
    if row_ready "$table" "$app"; then
      echo "$app: ready"
    else
      echo "$app: not ready yet"
      all_ready=0
    fi
  done
  if [ "$all_ready" = 1 ]; then
    echo "Container rollout settled."
    exit 0
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "::error::Timed out waiting for container rollout. Last 'wrangler containers list' output:"
    echo "$table"
    exit 1
  fi
  sleep "$INTERVAL"
done
