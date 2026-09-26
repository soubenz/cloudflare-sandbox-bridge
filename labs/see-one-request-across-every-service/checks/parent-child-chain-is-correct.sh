#!/usr/bin/env bash
# Outcome-based: reuses the same fired request and pulled trace as
# one-trace-not-many, but asserts the stronger property -- every non-root
# span's parent is a real span that actually exists in this trace, and each
# hop's span genuinely descends from the span that called it (gateway ->
# worker -> storage), not just "same trace id". See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" parent-child-chain-is-correct
