#!/usr/bin/env bash
# The anti-cheat: stops the first two checks being satisfied by handing out
# a token that can do more than this lab asks for. Shares the same grader
# run as the other two checks. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" client-token-cannot-escalate
