#!/usr/bin/env bash
# Outcome-based: derives the true answer to each of the brief's three
# questions by actually running the onboarding sequence itself, live,
# against the same LiteLLM and ContextForge this session runs -- never a
# hard-coded value -- and compares them against /workspace/answers.json.
# See _harness.py for the shared re-derivation this and the other check
# both read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" answers-match-the-live-onboarding
