#!/usr/bin/env bash
# Appends one more round of traffic to the shipped traffic file: another run
# of the noisy tenant's import job, and one ordinary call from each of the
# three quiet tenants. Runs root-owned, cwd /opt/lab, killed after 30s.
set -euo pipefail
PY="$(command -v python3 || command -v python || true)"
TRAFFIC_FILE="${TRAFFIC_FILE:-/workspace/traffic.json}"
[ -z "$PY" ] && exit 0
[ -f "$TRAFFIC_FILE" ] || exit 0

"$PY" - "$TRAFFIC_FILE" << 'PYEOF'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    doc = json.load(handle)

requests = doc.setdefault("requests", [])
n = len(requests) + 1


def add(tenant, kind, text):
    global n
    requests.append({"id": "Q-%04d" % n, "tenant": tenant, "kind": kind, "text": text})
    n += 1


log_lines = ["run=9  pipeline=catalogue-import  worker=brambling-ingest-03"]
for i in range(40):
    sku = 481200 + i * 13
    log_lines.append(
        "  row=%05d sku=BR-%06d stage=validate status=reject reason=attribute_set_mismatch "
        "ref=%08x" % (i, sku, sku * 31 & 0xFFFFFFF)
    )
log_lines.append("finished  ok=0 warn=0 reject=40 exit=1")

add("acct_brambling", "import-log",
    "The import ran again and failed the same way, run 9 now. Read the log below and tell "
    "me if this is the same root cause as before.\n\n" + "\n".join(log_lines))
add("acct_kestrel", "dispatch-triage",
    "One more for the board: \"Delivery refused at the gate, consignee says wrong pallet "
    "count on the note.\" Categories: delay, breakdown, customs, paperwork, other.")
add("acct_wrenfield", "referral-note",
    "Short note: \"52M, follow-up for the referral sent last week, no new symptoms, just "
    "confirming it was received.\" Keep it to one line back to the referrer.")
add("acct_pipit", "product-title",
    "Tidy this one too, same rules: \"NEW STYLE oven glove SET OF 2 heat resistant "
    "FLAME retardant\"")

with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PYEOF
