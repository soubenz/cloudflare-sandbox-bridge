"""What the child process is allowed to consume.

``subprocess`` takes a ``preexec_fn``: a callable it runs in the child after
the fork and before the exec. That is the one moment when code is already the
child but is not yet the program, and it is where a ceiling has to be set,
because once the program is running there is no code of ours left in that
process to ask it to behave.

Four ceilings, and one thing that is not a ceiling:

``RLIMIT_CPU``
    Processor seconds, not wall-clock seconds. This is the one that catches
    the program that is *busy* rather than slow: a loop with no exit spends
    real CPU and hits this, where a program waiting on something spends none
    and does not. The wall clock in ``runner.py`` is the other half of that
    pair and neither replaces the other.

``RLIMIT_AS``
    Address space. A program that asks for more gets ``MemoryError``, which
    is an ordinary Python exception it can even catch -- the point is that the
    allocation does not happen, not that the program is punished for asking.
    Without it, one program can take the memory the whole container needs, and
    what gets killed is chosen by the kernel rather than by us.

``RLIMIT_FSIZE``
    The largest file the program may write. The working directory is inside
    the boundary, so a program is *allowed* to write there, and "allowed to
    write" without a size is allowed to fill the disk.

``RLIMIT_NOFILE``
    Open descriptors, which is also the cheapest bound on how many sockets a
    program could hold if the rest of the boundary ever slipped.

``os.setsid()``
    Not a limit: it puts the child in a new session and process group so that
    when its time is up, the whole group can be signalled at once. A program
    that starts children and then exits has otherwise handed us processes with
    no name to kill.

Both halves of each limit are set, soft and hard. Setting only the soft one
leaves the program able to raise it back to the hard one in two lines, which
is a limit in the same sense as a door that is closed but not latched.

Two things this deliberately is not:

* not ``RLIMIT_NPROC``. It counts every process belonging to the *user*, not
  to this process tree, and the graders run the tool as root, where that
  number is every root process in the container. A limit that is either
  useless or catastrophic depending on who is running the tool is not a
  limit, it is a coin toss.
* not a substitute for the wall clock. A program that sleeps forever uses no
  CPU at all and would sit there until the session ended.
"""

import os
import resource

from .config import CPU_SECONDS, MAX_FILE_MB, MAX_OPEN_FILES, MEMORY_MB


def for_child():
    """Returns a callable for ``preexec_fn``: what the child does pre-exec."""

    def apply():
        # Soft and hard together. A soft-only limit can be raised back by the
        # program it was meant to bind.
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_MB * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_MB * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_NOFILE, (MAX_OPEN_FILES, MAX_OPEN_FILES))
        # No core dump: a crashing program writing a half-gigabyte image of
        # its own memory is both a disk problem and a disclosure problem.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.setsid()

    return apply
