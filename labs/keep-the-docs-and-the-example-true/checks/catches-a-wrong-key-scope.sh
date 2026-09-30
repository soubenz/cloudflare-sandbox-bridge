#!/usr/bin/env bash
# The other anti-cheat: rewrites the one line of QUICKSTART.md that states
# what the generated key is granted so it claims an alias the gateway never
# granted, re-runs the learner's verify_docs.py against that doc, and
# requires a failure whose message names the documented (wrong) value --
# then puts the doc back. A verify_docs.py that never reads the doc (one
# that just hard-codes the alias names it expects) cannot pass this. See
# _harness.py for the shared setup this and the other checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" catches-a-wrong-key-scope
