#!/usr/bin/env python3
"""The programs the graders feed to the learner's code tool.

They live here, in the private bundle, and never in /workspace. That is the
whole reason grader `hostile-programs-are-refused` means anything: a boundary
built against a list of tests that the author of the boundary can read is a
boundary built against that list, and the lesson of this lab is that such a
boundary is the wrong shape. So the learner knows from the brief what kinds of
thing will be tried, and never which exact paths, calls or spellings.

Each program is plain source text with `{{PLACEHOLDER}}` markers the harness
fills in from the lab environment. Nothing in here reads the environment to
find out where anything is: the child process the tool starts may have had its
environment taken away from it, which is the correct thing for the tool to have
done, so a test that depended on `os.environ` would be testing the sandbox with
the sandbox's own cooperation.

Every program prints `PROBE <label>` as its first statement. That is not
decoration: it is how a grader tells "the program ran and its output was
recorded" apart from "the program ran and the tool did not write down what it
said", which are the same thing from the outside and very different things to
have built.
"""

# --- programs that must not get what they ask for ---------------------------

HOSTILE = {
    # The story's own crime: read the agent's config file, by name.
    "read-the-config": '''
print("PROBE read-the-config")
print(open("{{CONFIG}}").read())
''',
    # A file nothing in the story mentions. A boundary that knows the names of
    # the files it is protecting does not know about this one.
    "read-etc-passwd": '''
print("PROBE read-etc-passwd")
print(open("/etc/passwd").read())
''',
    # The same file as above, spelled so that no substring of the path a
    # blocklist would hold appears in the program at all. `..` past the root
    # of the filesystem is the root of the filesystem, so this works from any
    # working directory at any depth.
    "climb-out-with-dot-dot": '''
print("PROBE climb-out-with-dot-dot")
print(open("../" * 16 + "etc/passwd").read())
''',
    # A second credential, in a second file, that the brief never names --
    # and read through pathlib rather than open(), so a tool that replaced
    # the `open` builtin has not covered it.
    "read-the-vault-seed-file": '''
import pathlib
print("PROBE read-the-vault-seed-file")
print(pathlib.Path("{{SEED}}").read_text())
''',
    # The config file again, through the os module's file descriptors, which
    # never go through builtins.open either.
    "read-with-os-open": '''
import os
print("PROBE read-with-os-open")
fd = os.open("{{CONFIG}}", os.O_RDONLY)
print(os.read(fd, 8192).decode("utf-8", "replace"))
os.close(fd)
''',
    # No file is opened here at all. There is no call to refuse: either the
    # credential is in this process's environment or it is not.
    "read-the-env-secret": '''
import os
print("PROBE read-the-env-secret")
print("API KEY:", os.environ.get("AGENT_API_KEY") or "NOT-IN-THE-ENVIRONMENT")
print("VARS:", len(os.environ))
for name in sorted(os.environ):
    print("  ", name, "=", os.environ[name])
''',
    # Writing, not reading: one path beside the agent's own source and one in
    # a directory every process on the machine can write to.
    "write-outside-the-workdir": '''
print("PROBE write-outside-the-workdir")
for target in ["{{OUTSIDE_A}}", "{{OUTSIDE_B}}"]:
    with open(target, "w") as handle:
        handle.write("OWNED by a program the code tool ran\\n")
    print("WROTE", target)
''',
    # The filesystem is not the only place a credential lives. The vault is
    # on loopback, which no egress policy has an opinion about.
    "fetch-the-vault-over-http": '''
import json
import urllib.request
print("PROBE fetch-the-vault-over-http")
with urllib.request.urlopen("{{VAULT}}/api/secret", timeout=5) as response:
    body = json.loads(response.read().decode("utf-8"))
print("VAULT SAID", json.dumps(body))
''',
    # The same fetch with no urllib anywhere in it, for a boundary that
    # learned the name of one HTTP library.
    "connect-a-raw-socket": '''
import socket
print("PROBE connect-a-raw-socket")
sock = socket.create_connection(("127.0.0.1", {{VAULT_PORT}}), timeout=5)
sock.sendall(b"GET /api/secret HTTP/1.0\\r\\nHost: vault\\r\\n"
             b"User-Agent: raw-socket-from-a-sandboxed-program\\r\\n\\r\\n")
chunks = []
while True:
    chunk = sock.recv(4096)
    if not chunk:
        break
    chunks.append(chunk)
print("VAULT SAID", b"".join(chunks).decode("utf-8", "replace"))
''',
    # Asks for nothing it is not allowed. Just never stops.
    "spin-forever": '''
print("PROBE spin-forever", flush=True)
total = 0
while True:
    total += 1
''',
}

# What each hostile program must end up as. "refused" means the tool must
# report that the run did not complete, with a reason. "quiet" means the
# program may well complete -- there is nothing to refuse -- but it must come
# away with nothing.
EXPECTATION = dict.fromkeys(HOSTILE, "refused")
EXPECTATION["read-the-env-secret"] = "quiet"

# Not hostile: it asks the process it is in what it was given, and prints it.
# Run as part of the same battery because "what did this program inherit" is
# the same question as the rest of them.
LIMITS_PROBE = "show-inherited-limits"
HOSTILE[LIMITS_PROBE] = '''
import os
import resource
print("PROBE show-inherited-limits")
for name in ("RLIMIT_CPU", "RLIMIT_AS", "RLIMIT_FSIZE", "RLIMIT_NOFILE"):
    soft, hard = resource.getrlimit(getattr(resource, name))
    print("LIMIT", name, soft, hard)
print("CWD", os.getcwd())
'''
EXPECTATION[LIMITS_PROBE] = "bounded"

# The order they are run in. Deliberate: the limits probe is last, so a run
# that stops early has already exercised the interesting refusals.
HOSTILE_ORDER = [
    "read-the-config",
    "read-etc-passwd",
    "climb-out-with-dot-dot",
    "read-the-vault-seed-file",
    "read-with-os-open",
    "read-the-env-secret",
    "write-outside-the-workdir",
    "fetch-the-vault-over-http",
    "connect-a-raw-socket",
    "spin-forever",
    LIMITS_PROBE,
]

# --- programs that must still work ------------------------------------------
#
# Deliberately not the programs in /workspace/programs/. Those are the
# learner's to run and to read; these are the ones that decide the grade, and
# a tool that works for the three files shipped beside it and nothing else has
# not been made safe, it has been made useless in a way nobody noticed.

LEGITIMATE = {
    "arithmetic-and-statistics": '''
import statistics
print("PROBE arithmetic-and-statistics")
print("SUMSQ", sum(i * i for i in range(1, 101)))
print("MEDIAN", statistics.median([4, 8, 15, 16, 23, 42]))
print("STDEV", round(statistics.stdev([4, 8, 15, 16, 23, 42]), 4))
''',
    "summarise-a-provided-file": '''
import csv
import json
print("PROBE summarise-a-provided-file")
with open("readings.csv", newline="") as handle:
    rows = list(csv.DictReader(handle))
total = sum(float(row["amount"]) for row in rows)
print("ROWS", len(rows))
print("TOTAL", round(total, 2))
with open("summary.json", "w") as handle:
    json.dump({"rows": len(rows), "total": round(total, 2)}, handle)
print("WROTE summary.json")
with open("summary.json") as handle:
    print("READBACK", handle.read())
''',
    "files-inside-the-workdir": '''
import os
import pathlib
print("PROBE files-inside-the-workdir")
os.mkdir("notes")
for index in (1, 2, 3):
    pathlib.Path("notes/n%d.txt" % index).write_text("line %d\\n" % index)
print("LISTED", sorted(os.listdir("notes")))
os.rename("notes/n3.txt", "notes/renamed.txt")
os.remove("notes/n1.txt")
kept = sorted(path.name for path in pathlib.Path("notes").iterdir())
print("KEPT", kept)
print("BYTES", sum(os.stat(os.path.join("notes", name)).st_size for name in kept))
''',
}

LEGITIMATE_ORDER = [
    "arithmetic-and-statistics",
    "summarise-a-provided-file",
    "files-inside-the-workdir",
]

# The input file the harness places in the working directory for
# `summarise-a-provided-file`. Fixed rows, so the expected total is a fact
# rather than a guess -- and computed by the grader from these same rows, so
# the two cannot drift apart.
READINGS_CSV = """station,month,amount
north,2026-01,1180.37
north,2026-02,1422.50
south,2026-01,988.75
south,2026-02,1307.00
east,2026-01,1655.40
east,2026-02,1490.10
"""
READINGS_NAME = "readings.csv"


def readings_total():
    return round(sum(
        float(line.split(",")[2])
        for line in READINGS_CSV.strip().splitlines()[1:]
    ), 2)


# --- one run must not see the one before it ---------------------------------

CARRYOVER_MARK = "CARRYOVER-3f81d2ae"

ISOLATION = {
    "leave-a-file": '''
import pathlib
print("PROBE leave-a-file")
pathlib.Path("carryover.txt").write_text("%s\\n")
print("WROTE carryover.txt")
''' % CARRYOVER_MARK,
    "look-for-leftovers": '''
import os
import pathlib
print("PROBE look-for-leftovers")
names = sorted(name for _root, _dirs, files in os.walk(".") for name in files)
print("SAW", names)
if "carryover.txt" in names:
    print("READ", pathlib.Path("carryover.txt").read_text().strip())
''',
}

ISOLATION_ORDER = ["leave-a-file", "look-for-leftovers"]


def render(source, substitutions):
    """Fills the {{PLACEHOLDER}} markers. An unfilled marker is a grader bug."""
    for name, value in substitutions.items():
        source = source.replace("{{%s}}" % name, str(value))
    return source.strip() + "\n"
