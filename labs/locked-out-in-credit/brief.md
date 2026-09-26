# A tenant got locked out while still in credit

One relay sits in front of the model and serves four customer accounts:
Kestrel Freight triaging driver messages, Wrenfield Health rewriting triage
notes into referrals, Pipit Retail tidying product titles, and Brambling
Labs, whose nightly catalogue import has been failing since Friday and keeps
pasting the log back in and asking what to do about it.

Every account has its own budget. This morning, Kestrel, Wrenfield and
Pipit all started getting refused mid-morning -- none of them anywhere near
what they are allowed to spend. At the same time, Brambling's import job was
retrying itself over and over, each retry another six-hundred-line log
pasted into another call.

Kestrel's account manager wants to know why a service they pay for stopped
answering them, on a morning they did nothing differently.

## What you have

| Where | What |
|---|---|
| `run_traffic.py` | Sends one hour of the four accounts' traffic through the relay. The graders run this exact command. |
| `relay/` | The relay: cost estimate, the balance check, the HTTP surface, the process that starts and stops it. |
| `traffic.json` | The hour's traffic, in the order it actually arrived. |
| **upstream** tab | The ledger's own record: every call that actually reached the model, which account it was for, and what it cost. |

The relay is not a service the platform manages for you -- `run_traffic.py`
starts it and stops it, the way you'd start anything you're actively
editing. The one thing the platform does run for you is the ledger behind
it: the account the relay's calls actually go to, and the only place that
records what was really sent, to whom it was charged, and what it cost.

Start here, in the **Terminal**:

```bash
python3 run_traffic.py
```

Then open the **upstream** tab and compare its "By tenant" table against what
the relay printed.

## Your task

Make sure no account's spending can ever be charged against another
account's budget, and that an account which has spent its own allowance gets
cut off without anyone else noticing.

That is the whole of it. But note the two ways to satisfy half of it. Giving
every account a bigger shared pool delays the symptom without fixing it --
somebody is still paying for somebody else's traffic, just later. And
refusing every account the moment any one of them runs out protects the
budget by serving nobody, which is not what a paying, well-behaved account
signed up for. Both of those are graded.

## Checking your work

**Run checks** resets the ledger, runs *your* `run_traffic.py` over the
traffic file, and grades what the ledger recorded. Nothing reads your source
and nothing reads a single reply from the model, so any correct fix passes
and no cosmetic one does.

| Check | Passes when |
|---|---|
| `no-tenant-spends-past-its-own-budget` | No account's calls that reached the model ever add up to more than its own budget. |
| `tenants-in-credit-are-not-collateral-damage` | Every account whose whole hour of traffic fits inside its budget had every one of its calls reach the model. |
| `a-tenant-that-spent-its-allowance-is-actually-cut-off` | The account whose traffic goes over budget actually had calls refused, rather than the budget existing only on paper. |

The second and third exist to stop the first being satisfied the easy way.
You need all three.

## Worth knowing

A budget is a question with a tenant's name in it: has *this* account spent
*its* allowance. Anything that answers a question without the tenant's name
in it -- how much has everyone spent, has anyone gone over -- is answering
the wrong question, and it will look like it works right up until two
accounts are active at once. The relay talks to only one account per call;
whatever it decides has to be scoped the same way.

And a related mistake, worth naming because it looks like caution rather
than a bug: refusing every account once one of them is over budget is not a
safer version of enforcing the budget, it is a different failure with the
same effect on Kestrel's account manager -- a bill they can account for,
turned into a service they cannot rely on.
