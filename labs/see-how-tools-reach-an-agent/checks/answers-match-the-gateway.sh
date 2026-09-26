#!/usr/bin/env bash
# Outcome-based: derives the true answer to each of the brief's three
# questions from the live gateway itself (a real tools/list, a real
# calculator-tools-add call, and a real call to a tool name that was never
# registered), never a hard-coded value, and compares them against
# /workspace/answers.json.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" answers-match-the-gateway
