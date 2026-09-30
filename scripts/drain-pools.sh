#!/usr/bin/env bash
# Drain both warm pools so new containers boot on the freshly rolled-out
# image. Run only after wait-for-rollout.sh (docs/spike.md, "A deploy lesson").
set -euo pipefail

if [ -z "${OPALIX_KEY:-}" ] || [ -z "${OPALIX_URL:-}" ]; then
  echo "::notice::OPALIX_URL/OPALIX_KEY not set; skipping pool drain."
  exit 0
fi

for family in agent gateway; do
  echo "Draining $family pool"
  curl -fsS -X POST -H "Authorization: Bearer $OPALIX_KEY" "$OPALIX_URL/pools/$family/drain"
  echo
done
