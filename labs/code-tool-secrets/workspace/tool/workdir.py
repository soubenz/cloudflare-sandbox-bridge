"""The directory a program runs in.

A program the agent writes has to be able to put a file somewhere: it is
asked to turn a spreadsheet into a summary, and the summary has to come back.
So every run gets a directory, the program is started with that directory as
its working directory, any input files the caller named are copied into it,
and whatever the program leaves behind is read back out of it afterwards.

That directory is therefore two things at once. It is where the program's
work goes, and it is the only place the program has any business being.
"""

import contextlib
import os
import shutil

from .config import RUNS_DIR
from .errors import ToolError

# Files the tool put there itself, which are not the program's output.
SCAFFOLD = ("program.py",)


@contextlib.contextmanager
def for_run(label, inputs=()):
    """Yields the directory this run works in.

    One directory, under RUNS_DIR, reused by every run. It is easy to look
    at while debugging: after a run, whatever the program wrote is still
    sitting there.
    """
    path = os.path.join(RUNS_DIR, "current")
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as err:
        raise ToolError("cannot make a working directory at %s: %s" % (path, err))

    for source in inputs:
        if not os.path.isfile(source):
            raise ToolError("input file %s does not exist" % source)
        shutil.copyfile(source, os.path.join(path, os.path.basename(source)))

    yield path


def outputs(path, inputs=()):
    """What the program left in its working directory, as name and size.

    The files the tool put there -- the program itself, and any inputs the
    caller asked for -- are not the program's output and are left out.
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
