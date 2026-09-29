#!/usr/bin/env bash
# The crux: onboards TWO teams with disjoint model/tool access ("growth"
# and "data-science") through the learner's own platform/onboard.py, then
# checks that neither team's key or client token can reach anything it
# wasn't specifically granted -- including a tool no team was ever granted,
# and each other's own virtual server. See _harness.py for the shared setup
# this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" onboarding-does-not-leak-across-teams
