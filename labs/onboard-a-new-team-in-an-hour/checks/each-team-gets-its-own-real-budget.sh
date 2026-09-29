#!/usr/bin/env bash
# Confirms both onboarded teams ended up with a real, distinct, correctly
# set LiteLLM max_budget matching platform/team_catalog.yaml -- not a
# missing budget, not a hard-coded one, not one team's budget copied onto
# the other. See _harness.py for the shared setup this and the other two
# checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" each-team-gets-its-own-real-budget
