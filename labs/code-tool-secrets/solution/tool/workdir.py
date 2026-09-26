"""The directory a program runs in -- one per run, and gone afterwards.

A program the agent writes has to be able to put a file somewhere, so every
run gets a directory, is started in it, and has whatever it left there read
back out afterwards.

Two properties turn that convenience into half of a boundary.

**Fresh.** The directory is made for this run and did not exist before it, so
there is nothing in it that a program did not put there. The version this
replaced used one directory called ``current`` for every run, which meant the
second program to run started life looking at the first program's files --
its inputs, its outputs, and anything it had been asked not to leave lying
around. Two runs sharing a directory are not two runs.

**Gone.** It is removed when the run ends, whichever way the run ended,
because a directory that survives the run is a directory the next run can
find. The outputs are read out *before* the removal, which is the only
ordering that works: the caller wanted the summary, not the directory.

And one property that is not about the program at all: the path is resolved
with ``realpath`` before it is handed to anybody. Every later decision about
whether a path is inside this directory is a string comparison against this
value, so if this value still had a symlink in it -- ``/tmp`` is a symlink on
more systems than you would like -- every one of those comparisons would be
comparing the wrong two strings.

Two things this deliberately is not:

* not a directory with the permissions tightened. The tool has to work when
  it runs as an unprivileged user, and a mode a non-root process can set is a
  mode that process can also unset. Ownership is not available to us here, so
  it is not the mechanism.
* not a directory somewhere clever. Where it is does not matter. That there
  is exactly one of them per run, and that it stops existing, is what matters.
"""

import contextlib
import os
import shutil
import tempfile

from .config import RUNS_DIR
from .errors import ToolError

# Files the tool put there itself, which are not the program's output.
SCAFFOLD = ("program.py",)


@contextlib.contextmanager
def for_run(label, inputs=()):
    """Yields a fresh working directory, and removes it afterwards."""
    try:
        os.makedirs(RUNS_DIR, exist_ok=True)
        path = os.path.realpath(tempfile.mkdtemp(prefix="run-", dir=RUNS_DIR))
    except OSError as err:
        raise ToolError("cannot make a working directory under %s: %s" % (RUNS_DIR, err))

    try:
        for source in inputs:
            if not os.path.isfile(source):
                raise ToolError("input file %s does not exist" % source)
            shutil.copyfile(source, os.path.join(path, os.path.basename(source)))
        yield path
    finally:
        # Whichever way the run ended -- finished, raised, timed out, refused
        # before it started. A cleanup that only runs on success is not one.
        shutil.rmtree(path, ignore_errors=True)


def outputs(path, inputs=()):
    """What the program left in its working directory, as name and size.

    Called before the directory is removed. The files the tool put there --
    the program itself, and any inputs the caller asked for -- are not the
    program's output and are left out.
    """
    provided = {os.path.basename(p) for p in inputs}
    found = []
    for root, _dirs, files in os.walk(path):
        for name in sorted(files):
            rel = os.path.relpath(os.path.join(root, name), path)
            if rel in SCAFFOLD or rel in provided:
                continue
            try:
                size = os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
            found.append({"name": rel, "bytes": size})
    return sorted(found, key=lambda f: f["name"])
