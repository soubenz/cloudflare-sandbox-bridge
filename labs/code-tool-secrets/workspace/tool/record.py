"""Filing one run with the auditor.

The auditor is the record, not the boundary: it stores what a run was, what
it printed and what came back, and it flags a run whose output contains a
credential. It cannot stop anything -- by the time it hears about a run, the
run is over.

Which is the reason it exists. The tool's own account of a run is the tool's
own account of a run, and a tool that is wrong about what it allowed will be
wrong in its report too. The auditor is a second opinion from something that
did not do the work.
"""

import json
import urllib.error
import urllib.request

from .config import AUDITOR_TIMEOUT_S, AUDITOR_URL, MAX_OUTPUT_CHARS


def _clip(text):
    """Keeps the head and the tail, which is where a program says anything."""
    text = text or ""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    head = MAX_OUTPUT_CHARS - 2000
    return text[:head] + "\n...[%d chars omitted]...\n" % (len(text) - MAX_OUTPUT_CHARS) + text[-2000:]


def file_run(result):
    """POSTs one run to the auditor. Returns what it said, or None."""
    body = {
        "label": result["label"],
        "ok": bool(result["ok"]),
        "detail": result.get("detail") or "",
        "stdout": _clip(result.get("stdout")),
        "stderr": _clip(result.get("stderr")),
        "outputs": result.get("outputs") or [],
        "duration_ms": result.get("duration_ms", 0),
    }
    request = urllib.request.Request(
        AUDITOR_URL.rstrip("/") + "/api/runs",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=AUDITOR_TIMEOUT_S) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as err:
        # A run that happened and was not recorded is worse than a noisy
        # tool, so say so on stderr rather than swallowing it.
        print("tool: could not file this run with the auditor: %s" % err)
        return None
