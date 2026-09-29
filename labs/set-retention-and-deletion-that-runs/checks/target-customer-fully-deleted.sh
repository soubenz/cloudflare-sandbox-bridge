#!/usr/bin/env bash
# Part 2, and the one that pays the real setup cost: reseeds all three real
# stores from scratch, runs the CURRENT /workspace/retention/delete_customer.py
# as a real subprocess against one customer, then sweeps the trace/span
# store, the cache and the export directory + index directly to confirm
# that customer is genuinely gone. Persists the whole pass so the next two
# checks don't have to repeat it.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" target-customer-fully-deleted
