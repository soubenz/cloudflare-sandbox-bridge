"""What the child process is allowed to consume.

``subprocess`` takes a ``preexec_fn``: a callable it runs in the child after
the fork and before the exec, which is the one moment when code is already
the child but is not yet the program. Whatever is set there is in force for
the program and cannot be handed back, because by the time the program runs
there is no code of ours left in that process to ask.

The ``resource`` module is what sets those ceilings, and ``config.py``
already says what the desk thinks they should be.
"""


def for_child():
    """Returns a callable for ``preexec_fn``, or None for "nothing to do".

    Nothing to do, today: the program inherits this process's limits, which
    are whatever the container's are.
    """
    return None
