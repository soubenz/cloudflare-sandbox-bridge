#!/usr/bin/env bash
# Outcome-based: reconciles a FRESH gateway (own LiteLLM, own throwaway
# database) with the learner's platform/setup.py, then calls the gateway
# with whatever keys came out. See _harness.py for the shared setup this
# and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" team-keys-reach-only-their-models
