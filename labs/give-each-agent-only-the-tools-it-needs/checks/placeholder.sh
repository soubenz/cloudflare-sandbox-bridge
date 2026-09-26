#!/usr/bin/env bash
# Placeholder for part 1 of this lab -- the real, outcome-based grader
# (per-role token reaching only its own tools, refused everywhere else,
# the admin tool unreachable by any non-admin token, every refusal a real
# gateway 401/403/tool-not-found rather than client-side filtering) is
# built in part 2, following the shared-run harness pattern in
# checks/_harness.py from labs/one-endpoint-one-key and
# labs/hard-budget-per-team.
#
# This script exists only so the manifest has a checks[] entry to parse
# and `labs test`'s "at least one check fails on a fresh session" rule
# holds without a special case. It always fails.
set -euo pipefail

echo '{"pass": false, "message": "checks not implemented yet -- part 2 of this lab"}'
exit 1
