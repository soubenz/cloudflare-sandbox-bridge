#!/usr/bin/env python3
"""What the child process does before the program gets control.

This file is not imported by the tool. It is the child's entry point: the
runner starts a fresh interpreter on it, with the run's working directory and
the program's path as its two arguments, and it runs the program.

It matters that this runs *inside* the child. Some of what a process may do
is decided from outside, by whoever starts it -- its working directory, its
environment, what it is allowed to consume. The rest is decided by what the
interpreter has been told before the program's first line runs, because
after that line there is no moment left in which to tell it anything.

    python3 child.py <work-dir> <program.py>
"""

import runpy
import sys


def main():
    work, program = sys.argv[1], sys.argv[2]
    sys.dont_write_bytecode = True
    sys.argv = [program]

    # The program gets control on the next line. Nothing has happened to this
    # interpreter before it: it is an ordinary Python process that happens to
    # have been started in `work`.
    runpy.run_path(program, run_name="__main__")


if __name__ == "__main__":
    main()
