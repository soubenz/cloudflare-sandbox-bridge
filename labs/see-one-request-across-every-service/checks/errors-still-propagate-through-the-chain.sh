#!/usr/bin/env bash
# Outcome-based: fires a second real request that deliberately makes
# storage fail (trigger_error: true), then checks that (a) storage's own
# span shows a real ERROR status and (b) the chain is still one correctly
# connected, correctly parented trace across all three services despite the
# failure. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" errors-still-propagate-through-the-chain
