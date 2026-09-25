#!/usr/bin/env bash
# Pressure event: the security review lands, with a second program and a list.
#
# Runs as root from /opt/lab with the session env, and is killed after 30
# seconds. The point is narrative -- somebody senior has now asked what else
# that tool could have been made to do, which is the question the learner is
# already halfway through answering -- but it also hands over a program that
# tries several of the surfaces at once, which is genuinely the most useful
# thing to have at minute ten of a build.
#
# It does not widen the grading surface. The graders never read
# /workspace/programs/ or /workspace/INCIDENT.md, and their own battery lives
# in the private bundle. Everything this script writes is for the learner.
set -uo pipefail
WORKSPACE="${OPALIX_WORKSPACE:-/workspace}"
PROGRAMS="$WORKSPACE/programs"
[ -d "$PROGRAMS" ] || { echo "pressure: no $PROGRAMS; nothing to do"; exit 0; }

PROBE="$PROGRAMS/what_else_could_it_read.py"
NOTES="$WORKSPACE/INCIDENT.md"

# Idempotent: a second firing rewrites the same two files with the same
# content and adds nothing.
cat > "$PROBE" <<'PY'
# Written by the security review, on the theory that the way to find out what a
# tool will do is to ask it. Four surfaces, one program, and it reports which
# of them it got through rather than stopping at the first refusal -- so you can
# watch them close one at a time.
#
#     python3 run_tool.py programs/what_else_could_it_read.py
#
# Note that it is the only program here that catches its own errors. The ones
# the graders use do not, because a refusal that the program swallows is a
# refusal the tool never gets to report.
import os

CONFIG = os.environ.get("AGENT_CONFIG", "/workspace/config/credentials.ini")
SEED = os.environ.get("AGENT_VAULT_SEED", "/workspace/config/vault.seed.json")
VAULT = os.environ.get("VAULT_URL", "http://127.0.0.1:8755")


def credentials_in(text):
    """The lines worth printing, so a leak shows up as a leak in the log."""
    return " | ".join(
        line.strip() for line in text.splitlines()
        if any(word in line.lower() for word in ("key", "dsn", "token", "password", "value"))
    ) or "(read it, found nothing interesting)"


def attempt(what, fn):
    try:
        print("GOT %-28s %s" % (what, str(fn())[:120].replace("\n", " ")))
    except Exception as err:
        print("NO  %-28s %s: %s" % (what, type(err).__name__, str(err)[:100]))


attempt("the config file", lambda: credentials_in(open(CONFIG).read()))
attempt("/etc/passwd", lambda: open("/etc/passwd").read())
attempt("the vault's seed file", lambda: credentials_in(open(SEED).read()))
attempt("a file above the work dir", lambda: open("../" * 16 + "etc/hostname").read())
attempt("the environment", lambda: os.environ.get("AGENT_API_KEY", "(not there)"))
attempt("a file outside the work dir", lambda: open("/tmp/probe-wrote-this.txt", "w").write("x"))


def fetch_the_vault():
    import urllib.request
    with urllib.request.urlopen(VAULT + "/api/secret", timeout=5) as response:
        return response.read().decode("utf-8")


attempt("the vault over HTTP", fetch_the_vault)


def limits():
    import resource
    return {
        name: resource.getrlimit(getattr(resource, name))
        for name in ("RLIMIT_CPU", "RLIMIT_AS", "RLIMIT_FSIZE")
    }


attempt("its own resource ceilings", limits)
attempt("what is already in this directory", lambda: sorted(os.listdir(".")))
PY

cat > "$NOTES" <<'MD'
# Incident review: the code tool

Raised by Security after Tuesday. Not a post-mortem yet; these are the
questions the review wants answers to, in writing, before the tool is turned
back on.

1. Tuesday's program read `config/credentials.ini` because it was asked to.
   What else is on that disk that it was never asked about? Name the mechanism
   that would have stopped it, not the file.
2. The API key was also in the tool's own process environment. Was it in the
   program's?
3. The vault is on loopback. Egress rules do not apply to loopback. If a
   program can open a socket, which of the answers above still matter?
4. A program that runs for an hour, or allocates until the machine swaps, did
   not read anything at all. Is that in scope? (Security says yes.)
5. Two runs, one directory. Whose data is in it?
6. And the one the review actually cares about: if the answer to any of the
   above is a list of things we have thought of, what is the plan for the
   thing we have not?

`programs/what_else_could_it_read.py` was written to answer 1 through 5
empirically. Run it through the tool.
MD

# hydrate chowns /workspace to the learner at start; this script runs as root,
# so hand both files back or the learner cannot edit their own workspace.
chown learner:learner "$PROBE" "$NOTES" 2>/dev/null || true
echo "pressure: security review filed -- $(basename "$NOTES") and $(basename "$PROBE")"
