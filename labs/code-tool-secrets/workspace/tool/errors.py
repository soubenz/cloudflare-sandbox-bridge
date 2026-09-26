"""The two things that can go wrong, told apart.

``Refused`` is the tool declining to do something: the program asked for
something it is not allowed to have, or it ran longer than it may. The
program's author is told why, and the refusal is recorded.

``ToolError`` is the tool itself failing -- a missing interpreter, an
unwritable runs directory. That is not the program's fault and must not be
reported as though the program did something wrong.
"""


class Refused(Exception):
    """The program asked for something it may not have."""


class ToolError(Exception):
    """The tool could not do its job. Nothing to do with the program."""
