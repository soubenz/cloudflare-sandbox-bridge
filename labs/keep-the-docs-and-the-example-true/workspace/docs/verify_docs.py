#!/usr/bin/env python3
"""Verify that QUICKSTART.md is still true.

Compares what docs/QUICKSTART.md says with what the live gateway
($LITELLM_URL, $LITELLM_MASTER_KEY) actually does, and reports the result
as a single final line: {"pass": true|false, "message": "..."}.

On a mismatch the message should say what the doc claims and what the
gateway did instead.
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
