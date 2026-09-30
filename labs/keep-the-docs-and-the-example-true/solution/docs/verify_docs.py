#!/usr/bin/env python3
"""Verify that QUICKSTART.md is still true.

Pulls the three ```bash blocks out of QUICKSTART.md, runs them for real
against the live gateway ($LITELLM_URL, $LITELLM_MASTER_KEY, both already
in this environment), and checks the *real* output against what the doc's
own prose says should come back. Never reads gateway/config.yaml or
gateway/seed_model.py -- if the gateway's actual behavior no longer
matches the doc, this notices from the outside, the same way a new
teammate copy-pasting the doc would.

All three blocks run as one shell session (one `bash -c` invocation), not
three separate ones: block 1 does `export TEAM_KEY=...`, and blocks 2 and
3 need to see it, exactly like a learner pasting all three into one
terminal, one after another, would get for free. A `MARKER` line is echoed
before and after each block so this script can tell the three blocks'
outputs apart afterward.

What each block is expected to produce is read out of QUICKSTART.md's own
prose (the key's "models" list, the reply text and echoed model name, the
refusal status code) -- never hard-coded here -- so a doc whose claims
change, or a gateway that stops matching them, both fail with a message
quoting the documented value.

Each block's check reads only the fields QUICKSTART.md actually promises.
It deliberately never compares a full response body against a fixed
string: LiteLLM stamps every response with its own `created` (a real,
current Unix timestamp) and an `id`, neither of which the doc claims
anything about -- a comparison that included them would fail on a
perfectly correct, unchanged doc simply because the clock moved.
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DOC_PATH = os.path.join(HERE, "QUICKSTART.md")

BLOCK_RE = re.compile(r"```bash\n(.*?)```", re.DOTALL)
RUN_TIMEOUT_S = 30


def _claim(doc_text, pattern, what):
    """The first capture group of `pattern` in the doc's prose, or a
    ValueError saying which claim could not be found."""
    m = re.search(pattern, doc_text, re.DOTALL)
    if not m:
        raise ValueError("could not find the doc's claim about %s" % what)
    return m.group(1)


def _read_claims(doc_text):
    """What the doc's prose says each block produces."""
    return {
        "models": json.loads(_claim(
            doc_text, r'`"models"`\s+field\s+that\s+is\s+exactly\s+`(\[.*?\])`', 'the key\'s "models" field')),
        "content": _claim(
            doc_text, r'`"content":\s*"([^"]+)"`', "choices[0].message.content"),
        "model": _claim(
            doc_text, r'top-level\s+`"model"`\s+field\s+will\s+echo\s+`"([^"]+)"`', 'the top-level "model" field'),
        "status": _claim(
            doc_text, r'It\s+should\s+be\s+`(\d{3})`', "the refusal's HTTP status code"),
    }


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _extract_blocks(doc_text):
    return [m.strip("\n") for m in BLOCK_RE.findall(doc_text)]


def _run_all_blocks(blocks):
    """Runs every block in one shared shell session and returns a list of
    each block's own stdout (whatever it printed between its start and end
    markers), in order. Raises RuntimeError only for a grading-infrastructure
    problem (the shell itself never finished) -- a block's own command
    failing or printing something unexpected is not an exception, it shows
    up as that block's captured output being wrong, which the per-block
    checks below catch."""
    parts = []
    for i, block in enumerate(blocks):
        parts.append("echo '===BLOCK_%d_START==='" % i)
        parts.append(block)
        parts.append("echo")  # guarantee a newline before the end marker,
        parts.append("echo '===BLOCK_%d_END==='" % i)  # even if the block's own last line didn't print one
    script = "\n".join(parts)

    try:
        proc = subprocess.run(
            ["bash", "-c", script],
            capture_output=True, text=True, timeout=RUN_TIMEOUT_S,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("the documented commands did not finish within %ss" % RUN_TIMEOUT_S)

    outputs = []
    for i in range(len(blocks)):
        m = re.search(
            r"===BLOCK_%d_START===\n(.*?)\n===BLOCK_%d_END===" % (i, i),
            proc.stdout, re.DOTALL,
        )
        outputs.append(m.group(1) if m else "")
    return outputs, proc.stderr


def _check_create_key(output, claims):
    try:
        data = json.loads(output.strip())
    except ValueError:
        return False, "block 1 (get a key): the gateway's real response wasn't JSON: %r" % output[:300]
    key = data.get("key")
    if not isinstance(key, str) or not key.startswith("sk-"):
        return False, "block 1 (get a key): the doc says the response has a \"key\" field starting with sk-, but got %r" % key
    if data.get("models") != claims["models"]:
        return False, (
            "block 1 (get a key): the doc says this key's \"models\" is exactly %s, "
            "but the gateway actually returned %s" % (json.dumps(claims["models"]), json.dumps(data.get("models")))
        )
    return True, None


def _check_chat_completion(output, claims):
    try:
        data = json.loads(output.strip())
    except ValueError:
        return False, "block 2 (make your first call): the gateway's real response wasn't JSON: %r" % output[:300]
    if "error" in data:
        return False, (
            "block 2 (make your first call): the doc says calling model \"team-chat\" succeeds and "
            "returns \"%s\" in choices[0].message.content, but the gateway refused it: %r"
            % (claims["content"], data.get("error"))
        )
    model = data.get("model")
    content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
    if model != claims["model"]:
        return False, (
            "block 2 (make your first call): the doc says the response's \"model\" field echoes back "
            "\"%s\", but the gateway actually returned %r" % (claims["model"], model)
        )
    if content != claims["content"]:
        return False, (
            "block 2 (make your first call): the doc says you'll see "
            "\"%s\" in choices[0].message.content, but the gateway actually "
            "returned %r" % (claims["content"], content)
        )
    return True, None


def _check_scope_refusal(output, claims):
    status = output.strip()
    if status != claims["status"]:
        return False, (
            "block 3 (confirm you're actually scoped): the doc says calling \"platform-internal\" with "
            "your team key prints %s, but it actually printed %r" % (claims["status"], status)
        )
    return True, None


CHECKS = [_check_create_key, _check_chat_completion, _check_scope_refusal]


def main():
    try:
        with open(DOC_PATH) as f:
            doc_text = f.read()
    except OSError as e:
        _finish(False, "could not read %s: %s" % (DOC_PATH, e))

    try:
        claims = _read_claims(doc_text)
    except ValueError as e:
        _finish(False, "QUICKSTART.md: %s" % e)

    blocks = _extract_blocks(doc_text)
    if len(blocks) != len(CHECKS):
        _finish(
            False,
            "QUICKSTART.md now has %d ```bash blocks, but this script knows how to check %d -- "
            "update verify_docs.py to match" % (len(blocks), len(CHECKS)),
        )

    try:
        outputs, stderr_tail = _run_all_blocks(blocks)
    except RuntimeError as e:
        _finish(False, str(e))

    for check, output in zip(CHECKS, outputs):
        ok, message = check(output, claims)
        if not ok:
            _finish(False, message)

    _finish(True, "all %d documented commands still produce exactly what QUICKSTART.md says they do" % len(blocks))


if __name__ == "__main__":
    main()
