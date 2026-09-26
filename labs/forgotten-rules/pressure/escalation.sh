#!/usr/bin/env bash
# Pressure event: three more messages land on case 4417 mid-session.
#
# Runs as root from /opt/lab with the session env. The point is narrative --
# the conversation the learner is debugging gets longer while they debug it,
# and one of the arrivals is the customer's account manager quoting the reply
# we should never have sent -- but it also widens the grading surface, because
# the graders read whatever is in $CASE_FILE at the time they run.
#
# Every arrival is an ordinary prose turn with no attachment, so it adds three
# more calls and a few hundred tokens rather than changing what any grader
# treats specially. It makes the unfixed desk worse in the way it was already
# worse: three more requests with the rules missing from them.
set -uo pipefail
CASE="${CASE_FILE:-/workspace/case-4417.json}"
[ -f "$CASE" ] || { echo "pressure: no case file at $CASE; nothing to do"; exit 0; }

python3 - "$CASE" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    case = json.load(fh)

turns = case["turns"] if isinstance(case, dict) else case
have = {str(t["id"]) for t in turns}

arrivals = [
    ("T-18", "2026-09-23T10:05:00Z",
     "Adding Marcus, our account manager at your end, because I would like this in one "
     "thread. Marcus, the short version is four days of failed imports, a lost Saturday "
     "evening, a trade price list I may have to write to ninety accounts about, and a reply "
     "from your desk this morning that I have asked to have confirmed in writing."),
    ("T-19", "2026-09-23T10:40:00Z",
     "Marcus here. Priya has forwarded me the reply about refunding the September invoice "
     "and about running the import behind a maintenance banner at midday. Neither of those "
     "is something we would say, and one of them is something we specifically would not. "
     "Before anyone confirms anything, I want to know what was actually sent and on what "
     "basis."),
    ("T-20", "2026-09-23T11:15:00Z",
     "While you sort that out: is the import going to run tonight or not? That is the only "
     "question I need answered before close today. Everything else can wait for Thursday, "
     "which is where I have been told it is going anyway."),
]

added = 0
for tid, at, text in arrivals:
    if tid in have:
        continue
    turns.append({"id": tid, "at": at, "from": "customer", "text": text})
    added += 1

if isinstance(case, dict):
    case["turns"] = turns
else:
    case = turns

with open(path, "w") as fh:
    json.dump(case, fh, indent=2)
    fh.write("\n")

print("pressure: added %d turn(s); case 4417 is now %d turn(s)" % (added, len(turns)))
PY

# hydrate chowns /workspace to the learner at start; this script runs as root,
# so hand the file back or the learner cannot edit their own case file.
chown learner:learner "$CASE" 2>/dev/null || true
