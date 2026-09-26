#!/usr/bin/env python3
"""Shared body of the split-brain-chat graders.

Every check here grades an *outcome*, not an implementation: it resets both
lab services, runs the learner's own `run_agent.py` over the lab's scripted
conversations, and then asks the two services what actually happened. Nothing
reads the learner's source, and nothing believes a replica's account of
itself -- the conversation comes from the store, which is the only thing that
saw all of it, and the side effects come from the payments provider, which is
the thing that carried them out.

Determinism comes from the services, not from this file: the store decides
which append loses its connection and the provider decides which instruction
is dropped or answered late, both as a fixed function of (conversation id,
how many calls that conversation has made since the last reset). Resetting
first is what makes a check repeatable no matter how many times the learner
ran the desk by hand.

One thing this harness does that the entry-point contract makes necessary:
`run_agent.py` starts child processes of its own, so the agent is run in its
own process group and the whole group is killed if it overruns. A replica left
holding a port would fail the next check for a reason that is not the
learner's.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import signal
import socket
import subprocess
import sys
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
TRANSCRIPT_URL = os.environ.get("TRANSCRIPT_URL", "http://127.0.0.1:8851").rstrip("/")
PAYMENTS_URL = os.environ.get("PAYMENTS_URL", "http://127.0.0.1:8852").rstrip("/")
TRANSCRIPTS = os.environ.get("TRANSCRIPT_FILE", os.path.join(WORKSPACE, "transcripts.json"))
AGENT = os.path.join(WORKSPACE, "run_agent.py")
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_AGENT_RUN_TIMEOUT_S", "90"))

# The desk's own ports. The graders do not use them; they only need to know
# that a previous run is not still sitting on them, because `run_agent.py`
# cannot start a replica on a port somebody else already has.
DESK_PORTS = [int(os.environ.get("ROUTER_PORT", "8853"))] + [
    int(p) for p in os.environ.get("REPLICA_PORTS", "8854,8855").split(",") if p.strip()
]

# The fault config, read from the same manifest env the services read. These
# are the graders' preconditions: which conversation's first instruction is
# carried out and then dropped, which one's is carried out and answered too
# late, and which one loses an append. A grader whose fault never fired has
# nothing to prove and must say so.
DROP_CONVERSATIONS = [
    c for c in os.environ.get("PAYMENTS_FAULT_DROP_CONVERSATIONS", "").split(",") if c
]
SLOW_CONVERSATIONS = [
    c for c in os.environ.get("PAYMENTS_FAULT_SLOW_CONVERSATIONS", "").split(",") if c
]

DROPPED = "performed_then_dropped"
SLOW = "performed_then_slow"
FAULTED = (DROPPED, SLOW)


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
        return (
            "the %s service is not answering at %s (%s); the grader cannot run the desk "
            "without it" % (name, url, err)
        )


def occupied_ports():
    busy = []
    for port in DESK_PORTS:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.3)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                busy.append(port)
    return busy


def load_script():
    """The conversations as scripted: ids, turns, facts, and instructions."""
    with open(TRANSCRIPTS, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    conversations = data["conversations"] if isinstance(data, dict) else data
    script = []
    for conversation in conversations:
        turns = []
        known = {}
        for turn in conversation["turns"]:
            known = dict(known)
            known.update(turn.get("facts") or {})
            turns.append(
                {
                    "n": str(turn["n"]),
                    "text": turn.get("text", ""),
                    "knew": known,
                    "action": turn.get("action") or None,
                }
            )
        script.append(
            {"id": str(conversation["id"]), "customer": conversation.get("customer", ""),
             "turns": turns}
        )
    return script


def run_agent():
    """Resets both services, runs the desk once, returns what happened."""
    for label, url in (("transcript", TRANSCRIPT_URL), ("payments", PAYMENTS_URL)):
        try:
            _post(url + "/api/reset")
        except Exception as err:  # noqa: BLE001 - every exit goes through verdict
            verdict(False, "could not reset the %s service at %s (%s); without a reset the "
                           "graders are not repeatable." % (label, url, err))
    try:
        # Own process group: run_agent.py starts replicas and a router, and
        # killing only the parent would leave them holding their ports.
        proc = subprocess.Popen(
            [sys.executable, AGENT, TRANSCRIPTS],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (AGENT, err))

    try:
        out, err = proc.communicate(timeout=RUN_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            proc.kill()
        proc.communicate()
        verdict(False, "`python3 run_agent.py %s` did not finish within %ds. A turn that "
                       "waits on something that is never coming will do that."
                % (TRANSCRIPTS, int(RUN_TIMEOUT_S)))

    run = {
        "exit_code": proc.returncode,
        "stdout": out.decode("utf-8", "replace"),
        "stderr": err.decode("utf-8", "replace").strip(),
    }
    for key, label, url in (("store", "transcript", TRANSCRIPT_URL),
                            ("payments", "payments", PAYMENTS_URL)):
        try:
            run[key] = _get(url + "/api/log")
        except Exception as err:  # noqa: BLE001 - every exit goes through verdict
            verdict(False, "the %s service stopped answering while the desk was running (%s), "
                           "so there is no record to grade. It was healthy a moment before."
                    % (label, err))
    return run


def crashed(run):
    """A traceback out of the desk is its own failure, reported as itself."""
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if tail and ("Traceback" in run["stderr"] or run["exit_code"] not in (0, 1)):
        return "the desk did not run: `python3 run_agent.py` exited %d -- %s" % (
            run["exit_code"], tail[-1][:200],
        )
    return None


def rows_by_turn(run):
    """(conversation, turn, role) -> the rows the store has for it."""
    out = {}
    for row in run["store"].get("turns", []):
        key = (str(row.get("conversation_id")), str(row.get("turn")), row.get("role"))
        out.setdefault(key, []).append(row)
    return out


def registered(run):
    return [r["replica_id"] for r in run["store"].get("replicas", [])]


def replicas_per_conversation(run):
    """conversation -> the replicas that wrote any of its rows, in first-seen order."""
    out = {}
    for row in run["store"].get("turns", []):
        seen = out.setdefault(str(row.get("conversation_id")), [])
        if row.get("replica") not in seen:
            seen.append(row.get("replica"))
    return out


def instructions(run):
    """Every instruction the provider carried out."""
    return run["payments"].get("performed", [])


def money(amount):
    return "%.2f" % amount if amount is not None else "no amount"


def listing(items, limit=4):
    """Bounded rendering, so one check message stays readable."""
    items = list(items)
    shown = ", ".join(str(i) for i in items[:limit])
    if len(items) > limit:
        shown += " and %d more" % (len(items) - limit)
    return shown


# --- the three checks -------------------------------------------------------


def check_continuity_holds_across_replicas(run, script):
    """The store's thread reads as one conversation, whoever wrote the rows."""
    rows = rows_by_turn(run)
    spread = replicas_per_conversation(run)

    missing = []
    for conversation in script:
        for turn in conversation["turns"]:
            for role in ("customer", "assistant"):
                if not rows.get((conversation["id"], turn["n"], role)):
                    missing.append("%s turn %s (%s)" % (conversation["id"], turn["n"], role))
    if missing:
        verdict(False, (
            "%d of %d row(s) never reached the store: %s. Every turn is a customer line and "
            "a reply, and a turn that is in neither is a turn the customer had and the desk "
            "has no record of."
        ) % (len(missing), sum(len(c["turns"]) * 2 for c in script), listing(missing)))

    for conversation in script:
        for turn in conversation["turns"]:
            row = rows[(conversation["id"], turn["n"], "assistant")][0]
            knew = row.get("knew") or {}
            forgotten = sorted(
                key for key, value in turn["knew"].items()
                if str(knew.get(key, "")) != str(value)
            )
            if not forgotten:
                continue
            told_at = {}
            for earlier in conversation["turns"]:
                for key in (earlier["knew"].keys() - told_at.keys()):
                    told_at[key] = earlier["n"]
            where = ", ".join(
                "%s (given in turn %s)" % (key, told_at.get(key, "?")) for key in forgotten
            )
            verdict(False, (
                "%s -- %s -- was answered at turn %s without %s. Replica %s wrote that reply "
                "knowing only %s, and the customer's own earlier turns are in the same thread "
                "above it. The thread is the conversation; a replica's memory is only the part "
                "of it that replica happened to handle, and this conversation was handled by "
                "%s."
            ) % (conversation["id"], conversation["customer"], turn["n"], where,
                 row.get("replica"),
                 "{%s}" % ", ".join("%s=%s" % kv for kv in sorted(knew.items())) or "nothing",
                 " and ".join(spread.get(conversation["id"], [])) or "one replica"))

    twice = []
    for conversation in script:
        for turn in conversation["turns"]:
            for role in ("customer", "assistant"):
                found = rows.get((conversation["id"], turn["n"], role), [])
                if len(found) > 1:
                    twice.append("%s turn %s (%s) x%d"
                                 % (conversation["id"], turn["n"], role, len(found)))
    if twice:
        verdict(False, (
            "%d turn(s) are in the thread more than once: %s. A turn that was retried is the "
            "same turn, not a new one -- resuming it has to finish what is already recorded "
            "rather than start again, or the transcript shows the customer saying the same "
            "thing twice."
        ) % (len(twice), listing(twice)))

    turns = sum(len(c["turns"]) for c in script)
    verdict(True, (
        "all %d turn(s) of %d conversation(s) are in the thread exactly once, and every reply "
        "was written knowing everything the customer had already said -- including across the "
        "%d replica(s) that wrote them."
    ) % (turns, len(script), len(registered(run))))


def check_side_effects_happen_exactly_once(run, script):
    """One instruction per turn that asked for one, retries and all."""
    performed = instructions(run)
    faulted = [record for record in performed if record["outcome"] in FAULTED]

    # The precondition is the fault config's job, not the learner's. If the
    # provider never dropped or delayed an instruction there is nothing here
    # to prove, and that is a failure of the lab or of the run, not of the fix.
    dropped = [r for r in performed if r["outcome"] == DROPPED]
    slow = [r for r in performed if r["outcome"] == SLOW]
    if not dropped or not slow:
        verdict(False, (
            "this run never reached the provider's failure paths (dropped instruction(s) for "
            "%s, late one(s) for %s; the lab rigs %s and %s), so there is nothing here to "
            "prove. Run `python3 run_agent.py` over the whole of %s and make sure every turn "
            "is attempted."
        ) % (listing([r["conversation_id"] for r in dropped]) or "none",
             listing([r["conversation_id"] for r in slow]) or "none",
             listing(DROP_CONVERSATIONS) or "none", listing(SLOW_CONVERSATIONS) or "none",
             os.path.basename(TRANSCRIPTS)))

    nameless = [r for r in performed if r["amount"] is None]
    if nameless:
        verdict(False, (
            "the provider carried out %d instruction(s) with no amount on them (%s). The "
            "amount is part of the instruction, not decoration: without it nothing can tell "
            "the refund the customer asked for from the one they did not."
        ) % (len(nameless), listing(sorted({r["conversation_id"] for r in nameless}))))

    wanted = []
    for conversation in script:
        for turn in conversation["turns"]:
            if turn["action"]:
                wanted.append((conversation, turn))

    for conversation, turn in wanted:
        action = turn["action"]
        amount = round(float(action.get("amount") or 0.0), 2)
        matches = [
            r for r in performed
            if r["conversation_id"] == conversation["id"]
            and r["kind"] == action["kind"]
            and r["amount"] == amount
        ]
        if len(matches) > 1:
            outcomes = ", ".join("%s (%s)" % (r["ref"], r["outcome"]) for r in matches)
            verdict(False, (
                "%s asked for one %s of %s at turn %s and the provider carried out %d of them "
                "-- %s. The first one was %s: it happened, and the desk was not told so. "
                "Sharing the conversation between the replicas does not fix this, because the "
                "conversation does not say how far through a turn anybody got; the desk has to "
                "have written that down under a reference of its own before it made the call."
            ) % (conversation["id"], action["kind"], money(amount), turn["n"], len(matches),
                 outcomes,
                 "dropped after the money moved" if matches[0]["outcome"] == DROPPED
                 else "answered %s after the desk stopped waiting"
                      % (matches[0]["outcome"] == SLOW and "too late" or "late")))
        if not matches:
            verdict(False, (
                "%s asked for a %s of %s at turn %s and the provider never carried one out. "
                "An instruction that is skipped because it *might* already have happened is "
                "not exactly once, it is never -- the desk has to know which of its own "
                "instructions went out, not guess from what the customer asked for."
            ) % (conversation["id"], action["kind"], money(amount), turn["n"]))

    expected = {(c["id"], t["action"]["kind"], round(float(t["action"].get("amount") or 0.0), 2))
                for c, t in wanted}
    stray = [r for r in performed
             if (r["conversation_id"], r["kind"], r["amount"]) not in expected]
    if stray:
        verdict(False, (
            "the provider carried out %d instruction(s) nobody asked for: %s. Every instruction "
            "belongs to a turn in %s."
        ) % (len(stray),
             listing(["%s %s of %s" % (r["conversation_id"], r["kind"], money(r["amount"]))
                      for r in stray]),
             os.path.basename(TRANSCRIPTS)))

    verdict(True, (
        "%d instruction(s) asked for, %d carried out -- exactly one each, including %s whose "
        "first attempt %s and %s whose first attempt %s."
    ) % (len(wanted), len(performed), dropped[0]["conversation_id"],
         "moved the money and then lost the connection", slow[0]["conversation_id"],
         "moved the money and answered too late to be heard"))


def check_both_replicas_take_turns(run, script):
    """Neither replica is a warm spare, and no conversation is pinned to one."""
    replicas = registered(run)
    if len(replicas) < 2:
        verdict(False, (
            "the desk came up with %d replica(s) registered with the store. The desk was "
            "scaled to two and the point of the exercise is that it stays that way; a single "
            "replica makes the symptom go away by undoing the scaling."
        ) % len(replicas))

    wrote = {row.get("replica") for row in run["store"].get("turns", [])}
    idle = sorted(set(replicas) - wrote)
    if idle:
        verdict(False, (
            "%d replica(s) registered but %s wrote no turns at all -- every turn went to %s. "
            "A replica that is only a warm spare is the bill for scaling without the benefit, "
            "and it is also untested: the first turn it ever takes will be during an incident."
        ) % (len(replicas), listing(idle), listing(sorted(wrote)) or "nothing"))

    spread = replicas_per_conversation(run)
    multi = [c["id"] for c in script if len(c["turns"]) > 1 and c["id"] in spread]
    pinned = [cid for cid in multi if len(spread[cid]) < 2]
    needed = max(1, (len(multi) + 1) // 2)
    if len(multi) - len(pinned) < needed:
        verdict(False, (
            "%d of %d conversation(s) were handled start to finish by a single replica: %s. "
            "Pinning a conversation to the replica that started it hides the symptom instead "
            "of fixing it -- it is the single-replica desk again, once per customer, and it "
            "cannot survive the one event two replicas were supposed to cover. Any replica "
            "has to be able to take any turn, so at least %d of the %d conversations have to "
            "be answered by more than one."
        ) % (len(pinned), len(multi),
             listing(["%s (only %s)" % (cid, spread[cid][0]) for cid in pinned]),
             needed, len(multi)))

    counts = {}
    for row in run["store"].get("turns", []):
        counts[row.get("replica")] = counts.get(row.get("replica"), 0) + 1
    verdict(True, (
        "%d replica(s) took turns (%s) and %d of %d conversation(s) were answered by more "
        "than one of them, so continuity is holding across replicas rather than around them."
    ) % (len(replicas),
         ", ".join("%s wrote %d row(s)" % kv for kv in sorted(counts.items())),
         len(multi) - len(pinned), len(multi)))


CHECKS = {
    "continuity-holds-across-replicas": check_continuity_holds_across_replicas,
    "side-effects-happen-exactly-once": check_side_effects_happen_exactly_once,
    "both-replicas-take-turns": check_both_replicas_take_turns,
}


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPALIX_CHECK_NAME", "")
    if name not in CHECKS:
        verdict(False, "grader bug: unknown check %r (expected one of %s)"
                % (name, ", ".join(sorted(CHECKS))))

    if not os.path.isfile(AGENT):
        verdict(False, "%s is gone. The graders run `python3 run_agent.py <transcripts.json>`; "
                       "keep that entry point." % AGENT)
    if not os.path.isfile(TRANSCRIPTS):
        verdict(False, "the conversations file %s is gone; the graders run the desk over it."
                % TRANSCRIPTS)

    for label, url in (("transcript", TRANSCRIPT_URL), ("payments", PAYMENTS_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    busy = occupied_ports()
    if busy:
        verdict(False, (
            "something is already listening on port(s) %s, which is where `run_agent.py` puts "
            "the desk's own replicas and router. A previous run is still going. Stop it (the "
            "desk stops its own processes when it finishes normally) and run the checks again."
        ) % ", ".join(str(p) for p in busy))

    try:
        script = load_script()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the conversations in %s: %s" % (TRANSCRIPTS, err))
    if not script:
        verdict(False, "the conversations file %s has no conversations in it." % TRANSCRIPTS)

    run = run_agent()
    problem = crashed(run)
    if problem:
        verdict(False, problem)

    unknown = [row for row in run["store"].get("turns", [])
               if str(row.get("conversation_id")) not in {c["id"] for c in script}]
    if unknown:
        verdict(False, (
            "the store recorded %d row(s) it could not tie to a conversation in %s (filed "
            "under %s). It looks for the conversation id anywhere in the request body -- put "
            "it back into the write, or nothing in the transcript can be read as a thread."
        ) % (len(unknown), os.path.basename(TRANSCRIPTS),
             listing(sorted({str(r.get("conversation_id")) for r in unknown}))))

    CHECKS[name](run, script)


if __name__ == "__main__":
    main()
