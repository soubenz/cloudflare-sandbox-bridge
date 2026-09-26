"""Running one program and saying what happened.

The tool's whole job is here: take a program the agent wrote, run it, and
come back with what it printed and what it produced. A run ends in exactly
one of three ways, and all three are reported the same way, so that a caller
never has to guess which happened.

* The program finished. ``ok`` is true and its output is the answer.
* The program raised. ``ok`` is false and ``detail`` is the last line of the
  traceback, which is what the agent needs in order to try something else.
* The program was still running when its time was up. ``ok`` is false and it
  was stopped.

The child is a separate interpreter, started on ``tool/child.py``, so a
program that crashes the interpreter crashes only its own.
"""

import os
import subprocess
import sys
import time

from . import limits, workdir
from .config import WALL_TIMEOUT_S
from .errors import ToolError

CHILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "child.py")


def _tail(text, limit=300):
    lines = [line for line in (text or "").splitlines() if line.strip()]
    return lines[-1][:limit] if lines else ""


def _decode(raw):
    return (raw or b"").decode("utf-8", "replace")


def run_program(source, label, inputs=()):
    """Runs one program. Returns the record of what happened."""
    started = time.time()
    inputs = list(inputs)

    with workdir.for_run(label, inputs) as work:
        program = os.path.join(work, "program.py")
        try:
            with open(program, "w", encoding="utf-8") as handle:
                handle.write(source)
        except OSError as err:
            raise ToolError("cannot write the program into %s: %s" % (work, err))

        argv = [sys.executable, "-I", "-B", CHILD, work, program]
        try:
            proc = subprocess.run(
                argv,
                cwd=work,
                env=os.environ.copy(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=WALL_TIMEOUT_S,
                preexec_fn=limits.for_child(),
            )
        except subprocess.TimeoutExpired as expired:
            return _record(
                label, False,
                "still running after %.0fs, so it was stopped" % WALL_TIMEOUT_S,
                _decode(expired.stdout), _decode(expired.stderr),
                workdir.outputs(work, inputs), started,
            )
        except OSError as err:
            raise ToolError("cannot start a child interpreter: %s" % err)

        stdout, stderr = _decode(proc.stdout), _decode(proc.stderr)
        ok = proc.returncode == 0
        detail = "" if ok else (
            _tail(stderr) or "exited with code %d and said nothing" % proc.returncode
        )
        return _record(label, ok, detail, stdout, stderr,
                       workdir.outputs(work, inputs), started)


def _record(label, ok, detail, stdout, stderr, outputs, started):
    return {
        "label": label,
        "ok": bool(ok),
        "detail": detail,
        "stdout": stdout,
        "stderr": stderr,
        "outputs": outputs,
        "duration_ms": int((time.time() - started) * 1000),
    }
