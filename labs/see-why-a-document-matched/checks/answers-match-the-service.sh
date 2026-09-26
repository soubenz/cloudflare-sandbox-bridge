#!/usr/bin/env bash
# Outcome-based: derives the true answer to each of the brief's three
# questions from the live retrieval service itself (two real /query calls,
# for the two fixed queries named in brief.md), never a hard-coded value,
# and compares them against /workspace/answers.json.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" answers-match-the-service
