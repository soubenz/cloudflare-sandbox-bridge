#!/usr/bin/env python3
"""Verify that QUICKSTART.md is still true.

QUICKSTART.md has three fenced ```bash code blocks. Each one is meant to be
copy-pasted into a real shell against the gateway that's already running in
this session ($LITELLM_URL, $LITELLM_MASTER_KEY are both in your
environment) -- and each one is followed by prose that says exactly what
running it should produce.

This script's job: pull those three blocks out of the doc, run them for
real against the live gateway, and check the real output against what the
doc claims. Not "does this look like a curl command" -- does the gateway
actually still answer the way the doc says it does, right now.

TODO(you): as shipped, `_run_block` below never actually calls the
gateway. It only checks that a block is well-formed shell (`bash -n`,
which parses a script without running it). That means this script always
reports "pass" no matter what the gateway actually does -- a QUICKSTART.md
that is completely wrong about the gateway's behavior still sails through.
Make `_run_block` actually execute each block (the three blocks need to
run in a way that lets `export TEAM_KEY=...` from block 1 be visible to
blocks 2 and 3, the same way a learner pasting them one after another into
one terminal would get that for free), and check the *real* output against
what QUICKSTART.md's own prose says should come back.
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DOC_PATH = os.path.join(HERE, "QUICKSTART.md")

BLOCK_RE = re.compile(r"```bash\n(.*?)```", re.DOTALL)


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _extract_blocks(doc_text):
    return [m.strip("\n") for m in BLOCK_RE.findall(doc_text)]


def _run_block(block_source):
    """Returns (ok, detail) for one code block.

    As shipped: only checks that the block is syntactically valid shell.
    Never touches the gateway, so it can never notice that the gateway
    stopped behaving the way the doc says it does.
    """
    proc = subprocess.run(
        ["bash", "-n"],
        input=block_source, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return False, "not valid shell: %s" % proc.stderr.strip()
    return True, "parses as valid shell"


def main():
    try:
        with open(DOC_PATH) as f:
            doc_text = f.read()
    except OSError as e:
        _finish(False, "could not read %s: %s" % (DOC_PATH, e))

    blocks = _extract_blocks(doc_text)
    if len(blocks) < 3:
        _finish(False, "expected at least 3 ```bash blocks in QUICKSTART.md, found %d" % len(blocks))

    for i, block in enumerate(blocks, start=1):
        ok, detail = _run_block(block)
        if not ok:
            _finish(False, "block %d: %s" % (i, detail))

    _finish(True, "all %d documented commands parse as valid shell" % len(blocks))


if __name__ == "__main__":
    main()
