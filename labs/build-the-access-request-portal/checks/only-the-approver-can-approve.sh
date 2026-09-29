#!/usr/bin/env bash
# Outcome-based: attempts to approve with no credential at all and with a
# credential that isn't the approver's, and confirms both are genuinely
# refused (a real 401/403 from the running service, not a client-side
# choice) and grant nothing -- then confirms the real approver token still
# works right after. See _harness.py for the shared setup this and the
# other three checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" only-the-approver-can-approve
