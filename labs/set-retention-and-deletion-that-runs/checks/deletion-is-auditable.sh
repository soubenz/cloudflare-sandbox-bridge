#!/usr/bin/env bash
# Part 4: a real auditor's sweep -- confirms no trace of the deleted
# customer exists anywhere across all three stores, AND that the live
# retention-api service's own /customers and /customers/{id}/audit
# endpoints (a second, independent code path over the same on-disk files)
# agree, while still listing the customers that were never deleted.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" deletion-is-auditable
