#!/usr/bin/env bash
# Outcome-based: derives the true answer to each of the brief's three
# questions from the live services themselves (never a hard-coded value)
# and compares them against /workspace/answers.json. Never resets the
# provider -- diffs its /log around one call of its own instead, so it
# never disturbs anything the learner already did.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" answers-match-the-gateway
