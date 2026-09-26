#!/usr/bin/env bash
# Outcome-based: calls the learner's tool server (via the grader's own
# throwaway ContextForge instance) with a wrong-typed argument to each
# tool and checks it comes back isError:true, not a crash and not a
# silently-accepted call. See _harness.py for the shared setup this and
# the other three checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" typed-inputs-are-enforced
