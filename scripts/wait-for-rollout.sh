#!/usr/bin/env bash
# Wait until both container applications have finished rolling out a deploy.
# `wrangler deploy --containers-rollout=immediate` returns before Cloudflare
# finishes (docs/spike.md, "A deploy lesson"), and a pool drain inside that
# window refills on the old image. On 2026-09-30 an earlier version of this
# script printed "ready" three seconds after the deploy while both apps were
# still provisioning: the settled state of the OLD rollout reads `active` or
# `ready` until Cloudflare flips the app to `provisioning`. So a row now counts
# only when its STATE column is exactly `active` or `ready` AND its LAST
# MODIFIED is at or after ROLLOUT_SINCE (the UTC time the deploy step started,
# ISO-8601, set by the workflow). If an app's configuration did not change in
# this deploy its LAST MODIFIED never moves, so after ROLLOUT_GRACE seconds
# (default 150) a plain `active`/`ready` is accepted too; an app that is
# provisioning is never accepted.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
set -uo pipefail

APPS=(opalix-sandbox-agentlab opalix-sandbox-gatewaylab)
INTERVAL="${ROLLOUT_INTERVAL:-15}"
GRACE="${ROLLOUT_GRACE:-150}"
SINCE="${ROLLOUT_SINCE:-}"
START=$(date +%s)
DEADLINE=$(( START + ${ROLLOUT_TIMEOUT:-900} ))

# The list output is a box-drawn table:
# │ <id> │ <name> │ <state> │ <live instances> │ <last modified> │
# Prints "<state> <last-modified>" for the row whose NAME column is exactly $2.
row_fields() {
  awk -F'│' -v want="$2" '
    { for (i = 1; i <= NF; i++) gsub(/^[ \t]+|[ \t]+$/, "", $i) }
    $3 == want { print $4, $6; exit }
  ' <<<"$1"
}

while true; do
  table="$(npx wrangler containers list 2>&1)" || true
  all_ready=1
  for app in "${APPS[@]}"; do
    read -r state modified < <(row_fields "$table" "$app")
    state="${state:-unknown}"
    fresh=0
    if [ -z "$SINCE" ] || [[ "$modified" > "$SINCE" || "$modified" == "$SINCE" ]]; then fresh=1; fi
    if [ $(( $(date +%s) - START )) -ge "$GRACE" ]; then fresh=1; fi
    if { [ "$state" = "active" ] || [ "$state" = "ready" ]; } && [ "$fresh" = 1 ]; then
      echo "$app: $state (modified ${modified:-?})"
    else
      echo "$app: not settled yet (state=$state modified=${modified:-?} since=${SINCE:-unset})"
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
