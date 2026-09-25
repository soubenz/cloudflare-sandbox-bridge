#!/usr/bin/env python3
"""Shared body of the locked-out-in-credit graders.

Every check here grades an outcome, not an implementation: it resets the
lab's one service, runs the learner's own `run_traffic.py`, and then asks
that service what actually reached the model. Nothing reads the learner's
source, and nothing depends on what the model said -- every assertion here
is about which calls reached the upstream ledger, for which tenant, and at
what cost, all of it read from the request bodies the ledger itself
received, never from what the relay claims about itself.

Determinism comes from the traffic file and the ledger's own token count,
not from this file and not from the provider: the same traffic, replayed
through a correct relay, produces the same admissions on every run, whether
or not a real model answered.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import subprocess
import sys
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
UPSTREAM_URL = os.environ.get("UPSTREAM_URL", "http://127.0.0.1:8933").rstrip("/")
TRAFFIC_FILE = os.environ.get("TRAFFIC_FILE", os.path.join(WORKSPACE, "traffic.json"))
DRIVER = os.path.join(WORKSPACE, "run_traffic.py")
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_AGENT_RUN_TIMEOUT_S", "150"))

TENANT_BUDGET_TOKENS = int(os.environ.get("TENANT_BUDGET_TOKENS", "1500"))
MAX_COMPLETION_TOKENS = int(os.environ.get("MAX_COMPLETION_TOKENS", "120"))


def verdict(passed, message):
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
        return ("the %s service is not answering at %s (%s); the grader cannot run "
                "the traffic without it" % (name, url, err))


def _tok(text):
    return max(1, (len(text) + 3) // 4)


def load_workloads():
    """tenant -> (request count, total token cost) computed straight from the
    traffic file, the same formula the ledger uses."""
    with open(TRAFFIC_FILE, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    requests = data.get("requests") or []
    workloads = {}
    for item in requests:
        tenant = item["tenant"]
        cost = _tok(item["text"]) + 4 + MAX_COMPLETION_TOKENS
        n, total = workloads.get(tenant, (0, 0))
        workloads[tenant] = (n + 1, total + cost)
    return workloads


def run_traffic():
    """Resets the ledger, runs the relay once over the full traffic file,
    returns what happened."""
    _post(UPSTREAM_URL + "/api/reset")
    try:
        proc = subprocess.run(
            [sys.executable, DRIVER, TRAFFIC_FILE],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, "`python3 run_traffic.py` did not finish within %ds. A relay that "
                       "keeps retrying a refusal, or that never refuses anything, takes "
                       "longer than one that decides once and moves on." % int(RUN_TIMEOUT_S))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (DRIVER, err))

    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace"),
        "stderr": proc.stderr.decode("utf-8", "replace").strip(),
        "ledger": _get(UPSTREAM_URL + "/api/log", timeout=30),
    }


def crashed(run):
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if tail and ("Traceback" in run["stderr"] or run["exit_code"] not in (0, 1)):
        return "the relay did not run: `python3 run_traffic.py` exited %d -- %s" % (
            run["exit_code"], tail[-1][:200])
    return None


def calls(run):
    return run["ledger"].get("calls") or []


def by_tenant_running_cost(run):
    """tenant -> list of (seq, cumulative cost after this call), in order."""
    out = {}
    running = {}
    for call in calls(run):
        t = call["tenant"]
        running[t] = running.get(t, 0) + call["cost_estimated"]
        out.setdefault(t, []).append((call["seq"], running[t]))
    return out


def received_counts(run):
    out = {}
    for call in calls(run):
        out[call["tenant"]] = out.get(call["tenant"], 0) + 1
    return out


def num(value):
    return "{:,}".format(int(value or 0))


def listing(items, limit=4):
    items = list(items)
    shown = ", ".join(str(i) for i in items[:limit])
    if len(items) > limit:
        shown += " and %d more" % (len(items) - limit)
    return shown


# --- the three checks --------------------------------------------------------


def check_no_tenant_spends_past_its_own_budget(run, workloads):
    running = by_tenant_running_cost(run)
    offenders = []
    for tenant, series in running.items():
        for seq, cum in series:
            if cum > TENANT_BUDGET_TOKENS:
                offenders.append((tenant, seq, cum))
                break

    if offenders:
        tenant, seq, cum = offenders[0]
        verdict(False, (
            "%s's own admitted calls add up to about %s token(s) by call #%d, which is over "
            "its %s-token budget -- and that call still reached the model. %d tenant(s) in "
            "total were let through past their own budget. A tenant's budget has to be spent "
            "in the unit the provider actually bills in: tokens, not the number of requests "
            "it happened to send. A tenant with fewer, larger requests can blow through a "
            "token budget while its request count looks perfectly ordinary."
        ) % (tenant, num(cum), seq, num(TENANT_BUDGET_TOKENS), len(offenders)))

    total_admitted = len(calls(run))
    verdict(True, (
        "every admitted call kept its tenant's running total at or under the %s-token "
        "budget, across all %d call(s) that reached the model."
    ) % (num(TENANT_BUDGET_TOKENS), total_admitted))


def check_a_tenant_that_spent_its_allowance_is_actually_cut_off(run, workloads):
    received = received_counts(run)
    over_budget = {t: (n, cost) for t, (n, cost) in workloads.items()
                   if cost > TENANT_BUDGET_TOKENS}

    if not over_budget:
        verdict(False, "no tenant in %s has a workload over the %s-token budget, so there "
                       "is nothing here for a cutoff to prove. That is a broken lab, not a "
                       "broken fix." % (os.path.basename(TRAFFIC_FILE), num(TENANT_BUDGET_TOKENS)))

    never_cut_off = []
    for tenant, (expected_n, cost) in over_budget.items():
        got = received.get(tenant, 0)
        if got >= expected_n:
            never_cut_off.append((tenant, got, expected_n, cost))

    if never_cut_off:
        tenant, got, expected_n, cost = never_cut_off[0]
        verdict(False, (
            "%s's traffic totals about %s token(s) against a %s-token budget, and every one "
            "of its %d request(s) still reached the model (%d of %d). Once a tenant has "
            "spent its allowance, at least one of its later requests has to be refused -- a "
            "budget that is tracked but never enforced protects nobody."
        ) % (tenant, num(cost), num(TENANT_BUDGET_TOKENS), expected_n, got, expected_n))

    tenant, (expected_n, cost) = next(iter(over_budget.items()))
    got = received.get(tenant, 0)
    verdict(True, (
        "%d tenant(s) whose workload is over the %s-token budget were actually cut off -- "
        "%s, for example, had only %d of its %d request(s) reach the model."
    ) % (len(over_budget), num(TENANT_BUDGET_TOKENS), tenant, got, expected_n))


def check_tenants_in_credit_are_not_collateral_damage(run, workloads):
    received = received_counts(run)
    in_credit = {t: (n, cost) for t, (n, cost) in workloads.items()
                 if cost <= TENANT_BUDGET_TOKENS}

    if len(in_credit) < 2:
        verdict(False, "fewer than two tenants in %s have a workload inside the %s-token "
                       "budget, so there is nothing here for isolation to prove. That is a "
                       "broken lab, not a broken fix." % (os.path.basename(TRAFFIC_FILE),
                                                          num(TENANT_BUDGET_TOKENS)))

    blocked = []
    for tenant, (expected_n, cost) in in_credit.items():
        got = received.get(tenant, 0)
        if got < expected_n:
            blocked.append((tenant, got, expected_n, cost))

    if blocked:
        tenant, got, expected_n, cost = blocked[0]
        verdict(False, (
            "%d of %d tenant(s) whose entire workload fits inside the %s-token budget still "
            "had calls that never reached the model. %s is the clearest case: its whole "
            "workload is about %s token(s), comfortably under budget, and yet only %d of its "
            "%d request(s) got through. A tenant's own spending is the only thing that may "
            "ever count against its own budget -- refusing it because some other tenant's "
            "account is empty is the same bug as sharing the counter in the first place, "
            "just applied at the door instead of at the ledger."
        ) % (len(blocked), len(in_credit), num(TENANT_BUDGET_TOKENS), tenant, num(cost),
             got, expected_n))

    verdict(True, (
        "all %d tenant(s) whose workload fits inside the %s-token budget had every one of "
        "their requests reach the model, regardless of what any other tenant spent."
    ) % (len(in_credit), num(TENANT_BUDGET_TOKENS)))


CHECKS = {
    "no-tenant-spends-past-its-own-budget": check_no_tenant_spends_past_its_own_budget,
    "a-tenant-that-spent-its-allowance-is-actually-cut-off":
        check_a_tenant_that_spent_its_allowance_is_actually_cut_off,
    "tenants-in-credit-are-not-collateral-damage":
        check_tenants_in_credit_are_not_collateral_damage,
}


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPALIX_CHECK_NAME", "")
    if name not in CHECKS:
        verdict(False, "grader bug: unknown check %r (expected one of %s)"
                % (name, ", ".join(sorted(CHECKS))))

    if not os.path.isfile(DRIVER):
        verdict(False, "%s is gone. The graders run `python3 run_traffic.py`; keep that "
                       "entry point." % DRIVER)
    if not os.path.isfile(TRAFFIC_FILE):
        verdict(False, "the traffic file %s is gone; the graders run the relay over it."
                % TRAFFIC_FILE)

    problem = reachable("upstream", UPSTREAM_URL)
    if problem:
        verdict(False, problem)

    try:
        workloads = load_workloads()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the traffic file %s: %s" % (TRAFFIC_FILE, err))
    if len(workloads) < 2:
        verdict(False, "the traffic file %s names fewer than two tenants; there is nothing "
                       "for a multi-tenant budget check to prove." % TRAFFIC_FILE)

    run = run_traffic()
    problem = crashed(run)
    if problem:
        verdict(False, problem)

    seen = calls(run)
    if not seen:
        verdict(False, (
            "not one request reached the model. The traffic file has %d tenant(s) with "
            "requests in it, and at least the ones with room in their budget should have "
            "been served. Refusing everyone is not a way to stay inside anyone's budget."
        ) % len(workloads))

    stray = [c for c in seen if c["tenant"] == "unknown"]
    if stray:
        verdict(False, (
            "the ledger could not tell which tenant %d of %d admitted request(s) belonged "
            "to. It looks for each known tenant id anywhere in the request body, so "
            "`unknown` means none of them were there -- keep the tenant's own id somewhere "
            "in what the relay forwards."
        ) % (len(stray), len(seen)))

    if not any(c["outcome"] == "answered" for c in seen):
        worst = seen[-1]
        verdict(False, (
            "not one of the %d admitted request(s) came back with a reply, so there is "
            "nothing here to grade about who got served. The ledger recorded the last one "
            "as `%s`%s. Check that the relay forwards an admitted call to $UPSTREAM_URL and "
            "returns what comes back."
        ) % (len(seen), worst["outcome"], " (%s)" % worst["note"][:140] if worst.get("note") else ""))

    CHECKS[name](run, workloads)


if __name__ == "__main__":
    main()
