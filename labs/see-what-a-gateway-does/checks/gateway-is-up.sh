#!/usr/bin/env bash
# Part 1 placeholder check: proves the stack genuinely boots and serves --
# LiteLLM reports ready and one real call through the 'support' alias
# succeeds. Part 2 replaces/extends this with checks that compare the
# learner's answers.json against what the running services actually report.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" gateway-is-up
