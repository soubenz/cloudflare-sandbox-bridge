#!/usr/bin/env bash
# Outcome-based: onboards a real team ("growth") against a FRESH LiteLLM +
# ContextForge (this script's own throwaway processes, own copies of the
# tool servers), using the learner's own platform/onboard.py unmodified,
# then calls through with whatever credentials.json came out -- including
# actually running the example.py it wrote. See _harness.py for the shared
# setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" onboarded-team-gets-what-it-needs
