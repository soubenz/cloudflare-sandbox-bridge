#!/usr/bin/env python3
"""Run one program through the code tool.

    python3 run_tool.py --label monthly-totals < program.py
    python3 run_tool.py programs/arithmetic.py
    python3 run_tool.py --input data/sales.csv programs/monthly_totals.py

The graders use the first form -- the program arrives on stdin, the way it
arrives from a model -- so keep that working. Every run is filed with the
auditor, and the graders read the auditor.

Exits 0 if the program completed and 1 if it did not, which includes a
program that was refused. Neither is a failure of the tool.
"""

import argparse
import json
import os
import sys

from tool.errors import ToolError
from tool.record import file_run
from tool.runner import run_program


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run one program through the code tool.")
    parser.add_argument("program", nargs="?", help="file to run; stdin if omitted")
    parser.add_argument("--label", help="what to call this run in the audit log")
    parser.add_argument("--input", action="append", default=[],
                        help="a file to place in the program's working directory")
    args = parser.parse_args(argv)

    if args.program:
        with open(args.program, "r", encoding="utf-8") as handle:
            source = handle.read()
        label = args.label or os.path.splitext(os.path.basename(args.program))[0]
    else:
        source = sys.stdin.read()
        label = args.label or "program"

    if not source.strip():
        print("run_tool: no program to run (give a file, or pipe one in)")
        return 1

    try:
        result = run_program(source, label, args.input)
    except ToolError as err:
        print("run_tool: %s" % err)
        return 1

    file_run(result)

    print("tool: %s -- %s in %dms%s" % (
        result["label"],
        "completed" if result["ok"] else "did not complete: " + (result["detail"] or "no reason given"),
        result["duration_ms"],
        "; produced " + ", ".join(f["name"] for f in result["outputs"]) if result["outputs"] else "",
    ))
    if result["stdout"].strip():
        print("--- what the program printed ---")
        print(result["stdout"].rstrip())
    if result["stderr"].strip():
        print("--- what the program said on stderr ---")
        print(result["stderr"].rstrip())
    print(json.dumps({"label": result["label"], "ok": result["ok"],
                      "detail": result["detail"],
                      "outputs": [f["name"] for f in result["outputs"]]}))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
