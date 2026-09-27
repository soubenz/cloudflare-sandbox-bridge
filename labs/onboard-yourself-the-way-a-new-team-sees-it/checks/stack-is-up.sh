#!/usr/bin/env bash
# Outcome-based: proves the stack genuinely boots and serves -- both
# gateways healthy, the pre-existing platform-core team and legacy-tools
# virtual server in place, and a real onboarding-shaped call (new team, new
# key, new tool registration, one real chat call plus one real tool call)
# succeeds end to end. See _harness.py for the shared, live re-derivation
# this and the other check both read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" stack-is-up
