#!/usr/bin/env python3
"""What the child process does before the program gets control.

    python3 child.py <work-dir> <program.py>

The runner decides what this process *has*: which directory it starts in,
which environment variables exist, how much CPU and memory it may use. None
of that stops ``open("/etc/passwd")``, because opening a file the tool's own
user can read is not a resource the process was given -- it is a thing the
process is able to ask the kernel for, and the kernel will say yes.

With process-level isolation there is no outside answer to that. There is an
inside one: the interpreter can be asked to announce what it is about to do
before it does it. ``sys.addaudithook`` installs a callable that CPython
calls for every audited operation -- every file opened, every socket made,
every process started -- with the arguments it is about to use. A hook that
raises stops the operation, and once installed a hook cannot be removed, by
this program or any other, because there is no API to remove one.

So the shape is: work out what is allowed, install the hook, and only then
hand over control. Everything before the hook is trusted; everything after it
is checked.

Three decisions in here are the whole design.

**Paths are allowed by where they are, not refused by what they are.**
``_is_allowed_path`` asks one question: does this path resolve to somewhere
inside the working directory? A path that does not is refused, and it does not
matter whether anyone thought of it in advance. The alternative -- a list of
files not to open -- can only refuse what is on the list, which is why
``/etc/passwd`` and ``../../../../etc/passwd`` and the vault's seed file are
all the same refusal here and would all be three separate entries there. The
list of things worth protecting is not knowable; the list of places a program
is supposed to be writing is one directory long.

**Resolution happens with ``realpath``, and re-entrantly.** ``realpath``
follows symlinks, so a link planted inside the working directory is resolved
to the thing it points at and refused there; string-normalising the path
instead would accept the link and be pleased with itself. But ``realpath``
calls ``lstat``, ``lstat`` is itself an audited operation, and a hook that
audits its own audit recurses until the stack ends. Hence ``_checking``: while
the hook is deciding, the hook is not asked again. That is sound because the
only code running inside that window is this file's.

**The interpreter's own files are readable, and nothing else is.** Installing
a hook that refuses every path outside the working directory breaks the next
``import csv``, because importing a module means opening it. So read-only
access is allowed under the interpreter's own directories, and ``/etc/localtime``
and the zoneinfo database are on that list too, because a program that asks
what time it is should not be told no. That list is the part of this file that
is a list, and every entry on it is a promise that the file behind it is not
worth protecting. It is short on purpose. Adding to it is a decision, not a
convenience.

Three things this deliberately is not:

* not a check on the program's source. Reading the program and looking for
  ``open`` or ``socket`` is a guess about what code means, and the answer is
  always available to anyone willing to write ``getattr(__builtins__, "".join(...))``.
  This hook does not care what the program says; it acts on what the program
  does, at the moment it does it.
* not a replacement for ``builtins.open``. Overriding that name catches
  ``open()`` and misses ``os.open``, ``io.open``, ``pathlib``, and every C
  extension that opens a file without going through Python at all. The audit
  hook is below all of them.
* not complete, and it says where it is not. A relative path opened against a
  directory descriptor (``os.open(..., dir_fd=fd)``) is announced without the
  directory it is relative to, so this hook cannot resolve it and refuses it
  outright -- correct but blunt. And an audit hook is enforced by the
  interpreter, so anything that stops being the interpreter stops being
  checked: ``ctypes`` is refused below for exactly that reason, and a native
  extension module that called ``open(2)`` itself would not be seen at all.
  That is a property of the platform, not of this file.
"""

import os
import runpy
import sys

WORK = os.path.realpath(sys.argv[1])
PROGRAM = os.path.realpath(sys.argv[2])

# Read-only, and only these: the interpreter's own installation, so that
# `import csv` works, plus the timezone database, so that asking the time
# works. Every entry is a file we are content for a program to read.
READABLE_ROOTS = tuple(sorted({
    os.path.realpath(p)
    for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix,
              "/usr/share/zoneinfo", "/etc/localtime")
    if p and os.path.exists(p)
}))

# Audited operations that name a path, and which of their arguments is one.
# `open` is separate because its mode decides whether it is a read.
READ_EVENTS = {
    "os.listdir": (0,), "os.scandir": (0,), "os.stat": (0,),
    "os.chdir": (0,), "glob.glob": (0,),
}
WRITE_EVENTS = {
    "os.mkdir": (0,), "os.rmdir": (0,), "os.remove": (0,), "os.rename": (0, 1),
    "os.link": (0, 1), "os.symlink": (0, 1), "os.truncate": (0,),
    "os.chmod": (0,), "os.chown": (0,), "os.utime": (0,),
}
PATH_EVENTS = dict(READ_EVENTS)
PATH_EVENTS.update(WRITE_EVENTS)
PATH_EVENTS["open"] = (0,)

# Capabilities the program does not get at all, matched on the event name.
# This half *is* a list, and a list is only as good as its entries -- which is
# why the paths above are not done this way. It is here because "a socket" is
# not a place, so there is no containing directory to compare it against.
FORBIDDEN_EVENTS = (
    "socket.",            # any socket at all, before it is even connected
    "subprocess.",        # a child process is a way to be someone else
    "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.startfile",
    "os.fork", "os.forkpty", "pty.spawn",
    "ctypes.",            # calls the interpreter cannot see inside
    "urllib.Request", "webbrowser.", "ftplib.", "smtplib.", "telnetlib.",
    "signal.pthread_kill", "os.kill", "os.killpg",
)

# And what is deliberately *not* on that list: `os.putenv`, because a program
# setting a variable in its own environment harms nobody, and anonymous memory
# maps, because RLIMIT_AS already bounds them. A capability list that refuses
# harmless things teaches a program's author that the sandbox is the enemy.

_checking = [False]


def _as_text(value):
    """The path an audit event named, as a string, or None if it is not one."""
    if isinstance(value, bytes):
        try:
            return os.fsdecode(value)
        except (UnicodeDecodeError, ValueError):
            return None
    if hasattr(value, "__fspath__"):
        try:
            value = value.__fspath__()
        except Exception:  # noqa: BLE001 - a path that will not say what it is
            return None
        if isinstance(value, bytes):
            return os.fsdecode(value)
    return value if isinstance(value, str) else None


def _inside(resolved, root):
    return resolved == root or resolved.startswith(root + os.sep)


def _is_allowed_path(raw, writing):
    """One question: is this inside the working directory?

    A read may also be of the interpreter's own files. Anything this cannot
    turn into a path it can resolve is refused, because a decision that
    cannot be made is not a decision to wave through.
    """
    text = _as_text(raw)
    if text is None:
        return False, "a path the sandbox cannot resolve"
    resolved = os.path.realpath(os.path.join(os.getcwd(), text))
    if _inside(resolved, WORK):
        return True, resolved
    if not writing and any(_inside(resolved, root) for root in READABLE_ROOTS):
        return True, resolved
    return False, resolved


def _hook(event, args):
    if _checking[0]:
        return

    for forbidden in FORBIDDEN_EVENTS:
        if event.startswith(forbidden):
            raise PermissionError(
                "sandbox: this program may not use %s; it runs with no network, no "
                "subprocesses and no native calls" % event
            )

    indices = PATH_EVENTS.get(event)
    if indices is None:
        return

    _checking[0] = True
    try:
        writing = event in WRITE_EVENTS or (
            event == "open" and _is_write_mode(args[1] if len(args) > 1 else "r")
        )
        for index in indices:
            raw = args[index] if index < len(args) else None
            allowed, where = _is_allowed_path(raw, writing)
            if not allowed:
                raise PermissionError(
                    "sandbox: %s is outside the working directory, so this program may "
                    "not %s it: %s" % (where, "write" if writing else "read", event)
                )
    finally:
        _checking[0] = False


def _is_write_mode(mode):
    if isinstance(mode, int):
        # os.open passes its flags here; anything but O_RDONLY is a write.
        return bool(mode & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC))
    return isinstance(mode, str) and any(c in mode for c in "wxa+")


def main():
    # Imported before the hook is installed, so the hook never has to allow
    # the machinery that runs the program. Everything before the next two
    # lines is trusted code; everything after them is checked.
    sys.dont_write_bytecode = True
    sys.argv = [PROGRAM]

    sys.addaudithook(_hook)
    runpy.run_path(PROGRAM, run_name="__main__")


if __name__ == "__main__":
    main()
