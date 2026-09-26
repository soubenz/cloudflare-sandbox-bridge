#!/usr/bin/env bash
# Outcome-based: ContextForge's own registration must report the
# learner's tool server as reachable, with both get_order and
# list_orders discovered and their real (typed) input schemas intact.
# See _harness.py for the shared setup this and the other three checks
# all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" registers-cleanly
