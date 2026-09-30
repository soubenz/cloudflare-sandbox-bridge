# A tenant got locked out while still in credit

One relay sits in front of the model and serves four customer accounts:
Kestrel Freight triaging driver messages, Wrenfield Health rewriting triage
notes into referrals, Pipit Retail tidying product titles, and Brambling
Labs, whose failing nightly catalogue import keeps pasting its six-hundred-line
log into another call and asking what to do.

Every account has its own budget. This morning Kestrel, Wrenfield and Pipit
all started getting refused, none of them anywhere near what they may spend,
while Brambling's import job was retrying itself over and over. Kestrel's
account manager wants to know why a service they pay for stopped answering on
a morning they did nothing differently.

## What is running

| Where | What |
|---|---|
| **`run_traffic.py`** | Starts the relay, sends one hour of the four accounts' traffic through it, and stops it. The graders run this exact command. |
| **`relay/`** | The relay you own: cost estimate, balance check, HTTP surface, and the process that starts it. |
| **`traffic.json`** | The hour's traffic, in arrival order. |
| **upstream** tab | The ledger, run by the platform: every call that actually reached the model, which account it was for, and what it cost. |

Start in the **Terminal** with `python3 run_traffic.py`, then compare the
upstream tab's "By tenant" table with what the relay printed.

## What done looks like

No account's spending can be charged against another account's budget, and an
account that has spent its own allowance is cut off without anyone else
noticing. A bigger shared pool only delays the symptom, and refusing everyone
once one account is over protects the budget by serving nobody. Both are graded.

## Checking your work

**Run checks** resets the ledger, runs *your* `run_traffic.py`, and grades what
the ledger recorded. Nothing reads your source or a single model reply.

| Check | Passes when |
|---|---|
| `no-tenant-spends-past-its-own-budget` | No account's calls that reached the model add up to more than its own budget. |
| `tenants-in-credit-are-not-collateral-damage` | Every account whose whole hour fits inside its budget had every call reach the model. |
| `a-tenant-that-spent-its-allowance-is-actually-cut-off` | The account whose traffic goes over budget actually had calls refused. |

You need all three.

Around minute 10 a second wave of traffic arrives; checks run against what is
true at the end.
