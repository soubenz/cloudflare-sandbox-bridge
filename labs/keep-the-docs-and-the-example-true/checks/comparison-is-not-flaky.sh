#!/usr/bin/env bash
# Runs the learner's verify_docs.py three separate times against the
# unchanged, currently-true doc (once before the drift test, twice after
# it's restored) and requires every run to report pass. Catches a
# verify_docs.py whose own comparison is unstable -- e.g. one that matches
# a full response body against a fixed string, which fails even on a
# correct, unchanged doc because LiteLLM stamps every response with its
# own real timestamp. See _harness.py for the shared setup this and the
# other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" comparison-is-not-flaky
