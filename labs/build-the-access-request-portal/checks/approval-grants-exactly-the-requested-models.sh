#!/usr/bin/env bash
# Outcome-based: approves a request with the real approver credential and
# calls the resulting LiteLLM key for the requested model, an unrequested
# catalog model, and the platform's own never-requestable alias. See
# _harness.py for the shared setup this and the other three checks all
# read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" approval-grants-exactly-the-requested-models
