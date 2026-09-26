"""Running one program and saying what happened.

The tool's job is unchanged: take a program, run it, come back with what it
printed and what it produced. What changed is everything the child inherits,
because a child process inherits a great deal by default and every one of
those defaults was decided for a different purpose than this one.

**The environment is built, not copied.** ``env=`` replaces the child's
environment rather than adding to it, so the child gets a dict with four keys
in it and there is nothing to leak. This is the only defence against a program
reading a credential out of ``os.environ``, because reading a dict is not an
operation the interpreter announces -- there is no hook that fires and nothing
to refuse. The secret has to not be there. ``HOME`` and ``TMPDIR`` point at
the working directory on purpose: a library that decides to write a cache file
should write it somewhere the program is allowed to write.

**The working directory is the run's own.** ``cwd=work`` is what makes a
relative path in the program resolve inside the boundary instead of wherever
the tool happens to have been started from.

**The limits are set between fork and exec.** ``preexec_fn`` is the only place
that can happen; see ``limits.py``.

**The wall clock is enforced on the group, not the process.** ``Popen`` plus
``communicate(timeout=...)``, and on a timeout ``os.killpg`` -- because
``limits.for_child()`` put the child in its own process group, and killing the
child alone would leave anything it started behind. ``RLIMIT_CPU`` catches the
program that is busy; this catches the program that is merely waiting, which
costs nothing and would otherwise wait until the session ended.

**stdin is /dev/null.** Not a security control, an honesty one: a program that
reads from a terminal that is not there should get an empty read rather than
block until the timeout and be reported as a runaway.

Two things this deliberately is not:

* not ``env={}``. An empty environment gives a child with no ``PATH``, and the
  failures that come out of that look like a broken sandbox rather than a
  working one. The list is short and every entry is dull; that is the point.
* not a filter on the program's source before it runs. The check that matters
  happens while the program runs, in ``child.py``, where what is being decided
  is an actual operation on an actual path rather than a guess about what a
  line of code might mean.
"""

import os
import signal
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


def _child_env(work):
    """The whole environment the program gets. Nothing is inherited."""
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": work,
        "TMPDIR": work,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }


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

        # -I: isolated. No PYTHON* variables from the environment, no user
        # site directory, and the current directory is not put on sys.path by
        # the interpreter. -B: no .pyc files written next to the program,
        # which would otherwise turn up in the run's outputs.
        argv = [sys.executable, "-I", "-B", CHILD, work, program]
        try:
            proc = subprocess.Popen(
                argv,
                cwd=work,
                env=_child_env(work),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
                preexec_fn=limits.for_child(),
            )
        except OSError as err:
            raise ToolError("cannot start a child interpreter: %s" % err)

        timed_out = False
        try:
            stdout, stderr = proc.communicate(timeout=WALL_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_group(proc)
            stdout, stderr = proc.communicate()

        stdout, stderr = _decode(stdout), _decode(stderr)
        if timed_out:
            detail = "still running after %.0fs of wall clock, so it was stopped" % WALL_TIMEOUT_S
            ok = False
        else:
            ok = proc.returncode == 0
            detail = "" if ok else (
                _tail(stderr) or _why_signalled(proc.returncode)
            )

        return _record(label, ok, detail, stdout, stderr,
                       workdir.outputs(work, inputs), started)


def _kill_group(proc):
    """The whole group, because the child was given one of its own.

    And only if it really was. If ``limits.for_child()`` did not call
    ``os.setsid()``, the child is still in *this* process's group, and
    ``killpg`` on it kills the tool as well -- a tool that dies whenever it
    stops a program has not stopped a program, it has crashed, and the agent
    on the other end gets no answer at all. So the group id is compared with
    our own before it is signalled, and a child that shares ours is killed on
    its own.
    """
    try:
        pgid = os.getpgid(proc.pid)
    except OSError:
        pgid = None
    if pgid is not None and pgid != os.getpgrp():
        try:
            os.killpg(pgid, signal.SIGKILL)
            return
        except OSError:
            pass
    try:
        proc.kill()
    except OSError:
        pass


def _why_signalled(code):
    """A program killed by a signal said nothing, so say it for it."""
    if code >= 0:
        return "exited with code %d and said nothing" % code
    try:
        name = signal.Signals(-code).name
    except ValueError:
        name = "signal %d" % -code
    if name == "SIGKILL":
        return ("stopped by SIGKILL, which is what running out of its CPU allowance or its "
                "memory looks like from here")
    return "stopped by %s" % name


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
