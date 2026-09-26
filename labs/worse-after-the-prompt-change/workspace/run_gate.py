#!/usr/bin/env python3
"""The gate's entry point. The graders run this exact command:

    python3 run_gate.py <candidate-name>

<candidate-name> is a module in candidates/ (without the .py), e.g.
`challenger_trim`. It always evaluates that candidate against the pinned
production baseline (candidates/production_current.py) over gate/cases.json,
and reports the decision to the release service.
"""

import sys

# No sys.path surgery needed: this file is run as `python3 run_gate.py`,
# which Python already answers by putting this script's own directory --
# whatever that is, not a literal "/workspace" -- at sys.path[0]. A
# hardcoded "/workspace" here would shadow that with whatever happens to
# exist at that literal path on the machine running it: harmless in a real
# session, where the workspace really is mounted there, but silently wrong
# for any offline run, local test, or CI invocation where it isn't -- and
# it found nothing to complain about either way, since import just succeeds
# against whichever `gate` package it lands on.
from gate import pipeline


def main():
    if len(sys.argv) != 2:
        print("usage: python3 run_gate.py <candidate-name>", file=sys.stderr)
        return 2
    candidate_name = sys.argv[1]
    try:
        result = pipeline.run(candidate_name)
    except Exception as err:  # noqa: BLE001
        print("gate crashed: %s: %s" % (type(err).__name__, err), file=sys.stderr)
        return 1

    print("candidate: %s" % result["candidate"])
    print("baseline:  %s (score %.3f)" % (result["baseline_candidate"], result["baseline_score"]))
    print("score:     %.3f" % result["candidate_score"])
    print("decision:  %s -- %s" % ("SHIP" if result["ship"] else "REFUSE", result["reason"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
