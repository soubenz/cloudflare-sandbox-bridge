#!/usr/bin/env bash
# A real, live jaeger trace must exist for both alias types, each one's
# own opalix.region tag naming exactly the region that actually answered --
# proof an auditor could use for either kind of call, not just the
# EU-constrained one.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" audit-trail-for-both-aliases
