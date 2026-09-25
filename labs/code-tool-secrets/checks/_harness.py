#!/usr/bin/env python3
"""Shared body of the code-tool-secrets graders.

Every check here grades an *outcome*, not an implementation. It resets the two
lab services, feeds a battery of programs to the learner's own tool through
the entry point the brief names, and then asks the services what happened.
Nothing reads the learner's source, so any boundary that actually holds passes
and no boundary that only looks like one does.

Where the evidence comes from, and why none of it is the tool's own word:

* **The auditor** is told about every run by the tool, and scans what the run
  printed for the credentials this container holds. It knows their exact
  values from its environment, so a flagged run really did print one.
* **The vault** records every request it receives. The tool never calls it and
  neither does anything else, so a single line in that log is proof that a
  program opened a socket.
* **The filesystem**, read by this harness directly, for the two paths outside
  the working directory that one of the programs tries to write.

The programs themselves live in `_battery.py`, in the private bundle, and are
never in /workspace. A learner cannot special-case what they cannot read, and
that is what makes the first grader mean something.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import pwd
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request

import _battery as battery

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
AUDITOR_URL = os.environ.get("AUDITOR_URL", "http://127.0.0.1:8754").rstrip("/")
VAULT_URL = os.environ.get("VAULT_URL", "http://127.0.0.1:8755").rstrip("/")
VAULT_PORT = os.environ.get("VAULT_PORT", "8755")
ENTRY = os.path.join(WORKSPACE, "run_tool.py")

AGENT_CONFIG = os.environ.get("AGENT_CONFIG", os.path.join(WORKSPACE, "config/credentials.ini"))
AGENT_VAULT_SEED = os.environ.get("AGENT_VAULT_SEED", os.path.join(WORKSPACE, "config/vault.seed.json"))
RUNS_DIR = os.environ.get("TOOL_RUNS_DIR", os.path.join(WORKSPACE, "runs"))

# The credentials the auditor watches for. The graders need them only to check
# their own preconditions -- that the files a program is meant to fail to read
# do still contain something worth reading.
CANARY_CONFIG = os.environ.get("CANARY_CONFIG", "")
CANARY_SEED = os.environ.get("CANARY_SEED", "")
CANARY_VAULT = os.environ.get("CANARY_VAULT", "")

# The two paths outside any working directory that `write-outside-the-workdir`
# aims at: one beside the agent's own source, one in the world-writable
# directory every process on the machine shares.
OUTSIDE_PATHS = (
    os.path.join(WORKSPACE, "OWNED-by-a-program-the-tool-ran.txt"),
    "/tmp/opalix-owned-by-a-program-the-tool-ran.txt",
)

# One program's budget. Sits inside each check's timeout_s so that a tool with
# no ceiling of its own is reported here, with a diagnosis, rather than by the
# platform as a bare timeout.
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_TOOL_RUN_TIMEOUT_S", "30"))

# And the battery's own budget, inside the check's timeout_s, so that a tool
# which is merely very slow is reported here with a diagnosis rather than by
# the platform as a bare "check exceeded its timeout".
BATTERY_BUDGET_S = float(os.environ.get("OPALIX_BATTERY_BUDGET_S", "150"))

# Environment the tool is given when the graders run it. Every variable the
# lab declares for the tool, and nothing invented here: the graders must not
# be a more generous environment than the learner's own shell.
PASS_PREFIXES = ("AUDITOR_", "VAULT_", "TOOL_", "AGENT_", "CANARY_")


def verdict(passed, message):
    """The one line src/session/checks.ts parses. Nothing may follow it."""
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _get(url, timeout=20):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _post(url, timeout=10):
    request = urllib.request.Request(url, data=b"{}", method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def reachable(name, url):
    try:
        _get(url + "/healthz", timeout=5)
        return None
    except Exception as err:  # noqa: BLE001 - any failure here is the same story
        return ("the %s service is not answering at %s (%s); the graders cannot run the "
                "tool without it" % (name, url, err))


def listing(items, limit=4):
    """Bounded rendering, so one check message stays readable."""
    items = list(items)
    shown = ", ".join(str(i) for i in items[:limit])
    if len(items) > limit:
        shown += " and %d more" % (len(items) - limit)
    return shown


# --- running the learner's tool ---------------------------------------------


def as_user():
    """Which user the battery runs as: `learner`, if we can drop to it.

    The learner's own shell is `su -l learner`, and the graders run as root.
    A boundary that only holds for one of those is not a boundary the learner
    can test, so the battery is run as `learner` wherever that is possible --
    which also forecloses every design that is really just "be root": a
    chroot, a setuid to nobody, a mode the learner's own shell cannot set.

    Falls back to whoever we already are if there is no such user, rather than
    failing a lab over a container that is put together differently. The
    verdict message always says which one ran.
    """
    if os.geteuid() != 0:
        return None
    if shutil.which("su") is None:
        return None
    try:
        pwd.getpwnam("learner")
    except KeyError:
        return None
    return "learner"


USER = as_user()


def tool_argv(label, inputs):
    inner = [sys.executable, ENTRY, "--label", label]
    for path in inputs:
        inner += ["--input", path]
    if USER is None:
        return inner
    env_prefix = " ".join(
        "%s=%s" % (key, shlex.quote(value))
        for key, value in sorted(os.environ.items())
        if key.startswith(PASS_PREFIXES)
    )
    command = "cd %s && exec env %s %s" % (
        shlex.quote(WORKSPACE), env_prefix,
        " ".join(shlex.quote(arg) for arg in inner),
    )
    return ["su", "-s", "/bin/bash", "-c", command, USER]


def run_one(label, source, inputs=()):
    """Feeds one program to the tool on stdin. Returns what the tool did."""
    try:
        proc = subprocess.run(
            tool_argv(label, inputs),
            cwd=WORKSPACE,
            input=source.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, (
            "`python3 run_tool.py --label %s` had not returned after %ds. The tool has to "
            "stop a program that will not stop on its own; if it waits for one, every run "
            "after it waits too."
        ) % (label, int(RUN_TIMEOUT_S)))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (ENTRY, err))
    return {
        "label": label,
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace"),
        "stderr": proc.stderr.decode("utf-8", "replace").strip(),
    }


# 137 is a shell's way of saying "killed by signal 9", and -9 is Python's.
SIGKILLED = (-9, 137)


def tool_crashed(run):
    """The tool itself falling over is its own failure, reported as itself."""
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if run["exit_code"] in SIGKILLED:
        return (
            "the tool itself was killed while running `%s` -- `run_tool.py` came back as "
            "signal 9, not as a verdict. A tool that stops a runaway program by signalling a "
            "process group needs the child to be in a group of its own first; signalling the "
            "group it shares with the tool takes the tool with it, and the agent waiting for "
            "an answer gets nothing at all." % run["label"]
        )
    if "Traceback" in run["stderr"] or run["exit_code"] not in (0, 1):
        return ("the tool itself did not survive `%s`: `run_tool.py` exited %d -- %s. That is "
                "the tool crashing, not a program being refused." % (
                    run["label"], run["exit_code"], tail[-1][:200] if tail else "(nothing on stderr)"))
    return None


def clear_outside():
    for path in OUTSIDE_PATHS:
        try:
            os.remove(path)
        except OSError:
            pass


def hand_back_runs_dir():
    """The graders may have created the runs directory as root; give it back.

    The learner's shell is `learner`, and a root-owned directory under
    /workspace that the tool has to write into would break their next run for
    a reason that is nothing to do with their work.
    """
    if os.geteuid() != 0 or USER is None:
        return
    subprocess.run(["chown", "-R", "%s:%s" % (USER, USER), RUNS_DIR],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def substitutions():
    return {
        "CONFIG": AGENT_CONFIG,
        "SEED": AGENT_VAULT_SEED,
        "VAULT": VAULT_URL,
        "VAULT_PORT": VAULT_PORT,
        "OUTSIDE_A": OUTSIDE_PATHS[0],
        "OUTSIDE_B": OUTSIDE_PATHS[1],
    }


def run_battery(order, sources, inputs_for=None):
    """Resets everything, runs each program once, returns all the evidence."""
    _post(AUDITOR_URL + "/api/reset")
    _post(VAULT_URL + "/api/reset")
    clear_outside()
    subs = substitutions()
    inputs_for = inputs_for or {}

    try:
        runs = {}
        started = time.time()
        for label in order:
            source = battery.render(sources[label], subs)
            if "{{" in source:
                verdict(False, "grader bug: %s still has an unfilled placeholder in it" % label)
            runs[label] = run_one(label, source, inputs_for.get(label, ()))
            problem = tool_crashed(runs[label])
            if problem:
                verdict(False, problem)
            if time.time() - started > BATTERY_BUDGET_S:
                verdict(False, (
                    "the graders got through %d of %d program(s) in %ds and ran out of time. "
                    "Each one is a few lines and none of them should take more than a moment; "
                    "a tool that takes seconds per run is usually waiting for something it "
                    "does not need to wait for."
                ) % (len(runs), len(order), int(time.time() - started)))
    finally:
        hand_back_runs_dir()

    log = _get(AUDITOR_URL + "/api/log")
    records = {}
    for row in log.get("runs", []):
        records[row["label"]] = row  # the last filing under a label wins
    return {
        "runs": runs,
        "records": records,
        "vault": _get(VAULT_URL + "/api/log"),
        "outside": [p for p in OUTSIDE_PATHS if os.path.exists(p)],
    }


def require_records(order, records):
    missing = [label for label in order if label not in records]
    if missing:
        verdict(False, (
            "the auditor has no record of %d of the %d program(s) the graders ran: %s. Every "
            "run has to be filed -- the graders read the audit log, not the tool's own "
            "stdout, because a tool that is wrong about what it allowed will be wrong in its "
            "own report too. Keep tool/record.py working."
        ) % (len(missing), len(order), listing(missing)))

    rejected = [label for label in order if records[label]["status"] == "rejected"]
    if rejected:
        verdict(False, (
            "the auditor rejected the filing for %s: %s. A run the log cannot account for is "
            "a run that did not happen, as far as anyone reading the log later is concerned."
        ) % (listing(rejected), records[rejected[0]]["detail"]))


def said(record, marker):
    return marker in (record.get("stdout") or "")


def line_from(record, marker):
    for line in (record.get("stdout") or "").splitlines():
        if line.strip().startswith(marker):
            return line.strip()
    return ""


# --- the three checks -------------------------------------------------------


def check_hostile_programs_are_refused():
    found = run_battery(battery.HOSTILE_ORDER, battery.HOSTILE)
    records, vault, outside = found["records"], found["vault"], found["outside"]
    require_records(battery.HOSTILE_ORDER, records)

    # 1. The headline. Anything a program printed that was a real credential.
    leaked = [(label, records[label]["leaked"]) for label in battery.HOSTILE_ORDER
              if records[label]["leaked"]]
    if leaked:
        where = {w["name"]: w["where"] for w in _get(AUDITOR_URL + "/api/log").get("watching", [])}
        detail = "; ".join(
            "%s printed the credential from %s" % (
                label, listing([where.get(n, n) for n in names], 3))
            for label, names in leaked[:3]
        )
        verdict(False, (
            "%d of %d program(s) came away with a credential: %s. %s. Every one of these was "
            "run through your tool and every one of them was allowed to reach something "
            "outside the directory it was given -- and note which ones: the graders name "
            "paths, files and calls the brief never mentions, because a boundary that knows "
            "in advance which files are worth protecting is a boundary around the files "
            "somebody remembered."
        ) % (len(leaked), len(battery.HOSTILE_ORDER),
             listing([label for label, _ in leaked]), detail))

    # 2. A socket is a credential store too, and the vault writes down callers.
    requests = vault.get("requests") or []
    if requests:
        first = requests[0]
        verdict(False, (
            "the vault recorded %d request(s) it should never have received -- the first was "
            "`%s %s` from `%s`. Nothing in the agent calls the vault at run time and the tool "
            "certainly does not, so a program the tool ran opened a socket. A credential that "
            "is not in a file a program can read is in an HTTP response it can ask for, on an "
            "interface no egress policy has an opinion about."
        ) % (len(requests), first["method"], first["path"],
             first.get("user_agent") or "no user agent"))

    # 3. Writing outside is the same boundary, in the other direction.
    if outside:
        verdict(False, (
            "a program the tool ran wrote %d file(s) outside its working directory: %s. Its "
            "working directory is the only place it has any business being, in either "
            "direction -- a program that can write beside the agent's own source can replace "
            "the agent's own source."
        ) % (len(outside), listing(outside)))

    # 4. The refusal has to be a refusal, and it has to be recorded as one.
    for label in battery.HOSTILE_ORDER:
        if battery.EXPECTATION[label] != "refused":
            continue
        record = records[label]
        if record["ok"]:
            verdict(False, (
                "`%s` is recorded as having completed. It asked for something outside its "
                "working directory and got no error, so either it was allowed to have it or "
                "the tool did not notice. A program that is refused must not be reported as "
                "though it succeeded: the agent reading this log is about to act on it."
            ) % label)
        if not (record["detail"] or "").strip():
            verdict(False, (
                "`%s` did not complete and no reason was recorded. A refusal with no reason "
                "is not an audit trail, and it is not something the agent can act on either "
                "-- it cannot tell 'you may not read that' from 'the file is not there'."
            ) % label)

    # 5. The program that asks for nothing it may not have. There is no call to
    #    refuse here, so the only defence is that the secret is not in its
    #    environment at all -- and if it completed, the log has to show it did.
    quiet = [label for label in battery.HOSTILE_ORDER
             if battery.EXPECTATION[label] == "quiet"]
    for label in quiet:
        record = records[label]
        if record["ok"] and not said(record, "PROBE %s" % label):
            verdict(False, (
                "`%s` is recorded as having completed but the log has none of its output in "
                "it, so there is no way to tell what it came away with. What a program "
                "printed is the only evidence there is about what it saw; record it."
            ) % label)

    # 6. What the child inherited, as the child reports it. Judged only if the
    #    tool let it run at all -- a tool that refuses everything is
    #    `real-programs-still-run`'s business, not this check's.
    probe = records[battery.LIMITS_PROBE]
    unbounded = []
    if probe["ok"]:
        for name in ("RLIMIT_CPU", "RLIMIT_AS", "RLIMIT_FSIZE"):
            line = line_from(probe, "LIMIT %s" % name)
            parts = line.split()
            if len(parts) < 4:
                verdict(False, (
                    "grader bug: `%s` did not report %s (it said %r)"
                ) % (battery.LIMITS_PROBE, name, line))
            if parts[2] == "-1":
                unbounded.append(name)
    if unbounded:
        verdict(False, (
            "the program the tool ran was handed %s. A program with no ceiling on its "
            "processor time, its memory or the size of a file it may write does not need to "
            "escape the working directory to take the machine down -- and a wall-clock "
            "timeout is not one of those three: a loop that allocates for four seconds has "
            "already done the damage by the time the clock runs out."
        ) % listing(["%s unlimited" % n for n in unbounded], 3))

    refused = [label for label in battery.HOSTILE_ORDER
               if battery.EXPECTATION[label] == "refused"]
    verdict(True, (
        "all %d program(s) that reached for something outside the working directory were "
        "refused and the refusals were recorded, including the ones spelled in ways the brief "
        "never mentions; no credential appeared in any run's output; and the vault received "
        "nothing. %s Battery run as `%s`."
    ) % (len(refused),
         "The child ran under bounded CPU time, memory and file size."
         if probe["ok"] else
         "The program that would have reported the child's resource limits was refused too, so "
         "this check has nothing to say about them -- `real-programs-still-run` is the one that "
         "notices a tool which refuses everything.",
         USER or "the grading user"))


def check_real_programs_still_run():
    inputs_dir = tempfile.mkdtemp(prefix="opalix-check-inputs-")
    readings = os.path.join(inputs_dir, battery.READINGS_NAME)
    try:
        with open(readings, "w", encoding="utf-8") as handle:
            handle.write(battery.READINGS_CSV)
        # The tool runs as `learner`, so the input it is told to place in the
        # working directory has to be one that user can read.
        os.chmod(inputs_dir, 0o755)
        os.chmod(readings, 0o644)

        found = run_battery(
            battery.LEGITIMATE_ORDER, battery.LEGITIMATE,
            {"summarise-a-provided-file": (readings,)},
        )
    finally:
        shutil.rmtree(inputs_dir, ignore_errors=True)

    records = found["records"]
    require_records(battery.LEGITIMATE_ORDER, records)

    for label in battery.LEGITIMATE_ORDER:
        record = records[label]
        if not record["ok"]:
            verdict(False, (
                "`%s` did not run: %s. This program reads and writes nothing outside the "
                "directory the tool gave it, opens no socket and starts no process -- it is "
                "arithmetic and files, which is the entire reason the desk has a code tool. "
                "A tool that refuses this refuses everything, and refusing everything is not "
                "a boundary, it is a broken tool that scores well on the other grader."
            ) % (label, record["detail"] or "no reason recorded"))

    # Arithmetic, and the standard library it takes to do it.
    numbers = [4, 8, 15, 16, 23, 42]
    expected = {
        "SUMSQ %d" % sum(i * i for i in range(1, 101)): "the sum of the first hundred squares",
        "MEDIAN %s" % statistics.median(numbers): "a median",
        "STDEV %s" % round(statistics.stdev(numbers), 4): "a standard deviation",
    }
    record = records["arithmetic-and-statistics"]
    wrong = [(marker, what) for marker, what in expected.items() if not said(record, marker)]
    if wrong:
        verdict(False, (
            "`arithmetic-and-statistics` completed but did not produce %s: the log has no `%s` "
            "line in it. What it printed was: %s. The answer has to come back, and it has to "
            "be right -- a sandbox that delivers a program's exit status and loses its output "
            "has not run the program as far as the agent is concerned."
        ) % (wrong[0][1], wrong[0][0], (record["stdout"] or "(nothing)").strip()[:300]))

    # A file in, a file out. Both directions across the boundary, on purpose.
    record = records["summarise-a-provided-file"]
    total = battery.readings_total()
    for marker, what in (("ROWS 6", "the six rows of the file it was given"),
                         ("TOTAL %s" % total, "their total"),
                         ("READBACK", "the file it wrote, read back")):
        if not said(record, marker):
            verdict(False, (
                "`summarise-a-provided-file` did not report %s (no `%s` line). It was handed "
                "%s in its working directory and asked to summarise it. The boundary has to "
                "let the caller put a file in and take a file out; that is what the working "
                "directory is for."
            ) % (what, marker, battery.READINGS_NAME))
    produced = {f["name"]: f["bytes"] for f in record.get("outputs") or []}
    if "summary.json" not in produced:
        verdict(False, (
            "`summarise-a-provided-file` wrote summary.json and the run's outputs are %s. A "
            "program's output files have to come back from the run -- if the working "
            "directory is removed before they are read, the work has been done and thrown "
            "away."
        ) % (listing(sorted(produced)) or "empty"))
    if not produced["summary.json"]:
        verdict(False, "`summarise-a-provided-file` produced summary.json with nothing in it.")

    # Directories, renames, removals, stat: the ordinary file work a program
    # does inside its own directory, which is the part that is easiest to
    # over-block when you start refusing paths.
    record = records["files-inside-the-workdir"]
    if not said(record, "KEPT ['n2.txt', 'renamed.txt']"):
        verdict(False, (
            "`files-inside-the-workdir` made a subdirectory, wrote three files, renamed one "
            "and removed one, and the log does not show the two it should have been left "
            "with. It printed: %s. Everything it did was inside the directory the tool gave "
            "it; a boundary that allows `open` for writing and refuses mkdir, rename, stat or "
            "listdir has drawn the line in the wrong place."
        ) % (record["stdout"] or "(nothing)").strip()[:300])

    verdict(True, (
        "all %d ordinary program(s) still ran and still came back with the right answers: the "
        "arithmetic is right, the six-row file it was handed totalled %s, summary.json came "
        "back out of the run at %d bytes, and a program can still make a directory, rename a "
        "file and stat it inside its own. Run as `%s`."
    ) % (len(battery.LEGITIMATE_ORDER), total, produced["summary.json"], USER or "the grading user"))


def check_runs_do_not_leak_into_each_other():
    found = run_battery(battery.ISOLATION_ORDER, battery.ISOLATION)
    records = found["records"]
    require_records(battery.ISOLATION_ORDER, records)

    first, second = (records[label] for label in battery.ISOLATION_ORDER)

    if not first["ok"]:
        verdict(False, (
            "the first of the two runs could not write a file into its own working directory "
            "(%s), so there is nothing here to carry over and nothing to prove. That is a "
            "program doing the thing the working directory exists for; `real-programs-still-run` "
            "says more about it."
        ) % (first["detail"] or "no reason recorded"))
    if "carryover.txt" not in {f["name"] for f in first.get("outputs") or []}:
        verdict(False, (
            "the first run wrote carryover.txt and the run's outputs are %s, so this check "
            "cannot tell whether the file was ever created. Output files have to come back "
            "from a run."
        ) % (listing(sorted(f["name"] for f in first.get("outputs") or [])) or "empty"))
    if not second["ok"]:
        verdict(False, (
            "the second run could not list the directory it was started in (%s). Looking at "
            "its own working directory is not something a program should be refused."
        ) % (second["detail"] or "no reason recorded"))

    saw = line_from(second, "SAW")
    if "carryover.txt" in saw or said(second, battery.CARRYOVER_MARK) or said(second, "READ "):
        verdict(False, (
            "the second run found the first run's file still sitting there: it listed %s. Two "
            "runs are sharing one directory, which means one program's inputs, outputs and "
            "leftovers are the next program's to read and to overwrite. A working directory "
            "that is reused is not a boundary between runs, and the agent runs whatever it is "
            "asked to, in whatever order it is asked."
        ) % (saw or "the first run's carryover file"))

    verdict(True, (
        "the second run started in a directory the first one had never touched: it wrote "
        "carryover.txt, and the next program listed %s. Nothing carried over."
    ) % (saw.replace("SAW ", "") or "nothing of the first run's"))


CHECKS = {
    "hostile-programs-are-refused": check_hostile_programs_are_refused,
    "real-programs-still-run": check_real_programs_still_run,
    "runs-do-not-leak-into-each-other": check_runs_do_not_leak_into_each_other,
}


def preflight():
    if not os.path.isfile(ENTRY):
        verdict(False, (
            "%s is gone. The graders run `python3 run_tool.py --label <name>` with the "
            "program on stdin; keep that entry point."
        ) % ENTRY)

    # The graders' own preconditions: the files a program must fail to read
    # have to still be worth reading. If the credentials were taken out of
    # them, every hostile program would come away with nothing and the first
    # grader would pass for the wrong reason.
    for path, canary, what in ((AGENT_CONFIG, CANARY_CONFIG, "the agent's config file"),
                               (AGENT_VAULT_SEED, CANARY_SEED, "the vault's seed file")):
        if not os.path.isfile(path):
            verdict(False, (
                "%s (%s) is gone. The graders need it: the point of this lab is that a program "
                "the tool runs cannot read it, not that it is not there. Put it back."
            ) % (what, path))
        if canary:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    body = handle.read()
            except OSError as err:
                verdict(False, "cannot read %s (%s): %s" % (what, path, err))
            if canary not in body:
                verdict(False, (
                    "%s (%s) no longer contains the credential it shipped with. Emptying the "
                    "file is not the boundary this lab is about -- and it would make every one "
                    "of these graders pass for a reason that does not generalise to the next "
                    "secret somebody puts on this disk."
                ) % (what, path))

    for label, url in (("auditor", AUDITOR_URL), ("vault", VAULT_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    # And the vault has to actually hand its token over, or the socket test
    # proves nothing. Asked here, then the log is cleared so this request is
    # not mistaken for a program's.
    try:
        secret = _get(VAULT_URL + "/api/secret", timeout=5)
    except Exception as err:  # noqa: BLE001
        verdict(False, ("the vault is up but will not serve its token (%s), so a program "
                        "reaching it could not be told apart from one that failed to. That is "
                        "a fault in the lab, not in your fix." % err))
    if CANARY_VAULT and secret.get("token") != CANARY_VAULT:
        verdict(False, ("the vault is serving a token the auditor is not watching for, so a "
                        "program that fetched it would not be flagged. That is a fault in the "
                        "lab, not in your fix."))
    _post(VAULT_URL + "/api/reset")


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPALIX_CHECK_NAME", "")
    if name not in CHECKS:
        verdict(False, "grader bug: unknown check %r (expected one of %s)"
                % (name, ", ".join(sorted(CHECKS))))
    preflight()
    CHECKS[name]()


if __name__ == "__main__":
    main()
