#!/usr/bin/env bash
# Outcome-based: the anti-cheat for the other two checks. A workspace that
# just handed every team the master key, or made billing_admin a real
# proxy admin, could otherwise pass "reaches its own models" and "can
# self-serve" trivially. See _harness.py for the shared setup this and the
# other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" no-one-holds-the-master-key
