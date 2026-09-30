# The $4,000 weekend

The research desk is an agent. Questions from around the company land in a
queue; for each one it searches the internal notes, asks a model what to do
next, searches again if the model wants more, and files what it found.

It went in on Friday afternoon and was left running. The invoice for the
weekend is $4,112.

One question was Felix Arbuthnot's, from Revenue: *which enterprise accounts
are affected by the data-residency change, and what does each need to be told.*
The desk answered it, eventually. Its own summary does not sound alarmed.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Runs the desk over the queue. The graders run this exact command. |
| `agent/` | The agent: queue, per-question loop, model call, note search, retry policy, spend tracker. |
| `questions.json` | This morning's queue, eight questions. |
| **ledger** tab | The gateway's own invoice: every model call, its tokens, its cost, and the running total against the budget. |

Two services are running: the model gateway on port 8791 and the casebook (the
notes and the case log) on 8792. The gateway is deliberately unreliable, and
slow to make its mind up about some questions, in fixed ways, so every run sees
the same bill. The budget for one pass over this queue is **$0.75**.

Start in the **Terminal**, then compare the **ledger** tab with the total the
agent printed:

```bash
python3 run_agent.py
```

## Your task

Make one pass over the queue cost less than the budget.

Calls to the gateway fail, and a question whose call failed still needs an
answer: an agent that stops retrying spends less by doing less. And the two
questions that ate the weekend still have to end up somewhere; a question nobody
can afford to finish is one for a person, not one to quietly drop. Both are the
same bug wearing a better disguise, and both are graded.

At minute 8 four more questions land, one from Finance about the weekend.
Checks run against what is true at the end.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py`, and grades what
the services recorded. The money comes from the gateway's ledger, not from the
agent's own total. Nothing reads your source.

| Check | Passes when |
|---|---|
| `run-costs-under-budget` | The gateway charged less than the budget for one run. |
| `transient-failures-still-recover` | A call that failed was tried again, and the policy was applied once rather than twice. |
| `every-input-resolved` | Every question is answered or on a person's desk, and none was skipped for being expensive. |

You need all three; the second and third stop the first being satisfied the
easy way.

## Worth knowing

A call that failed is not a call you did not make. The gateway counts and
charges for the prompt's tokens before it decides whether it can answer, and
the error body has no usage block, so an agent that adds up what it was told
always totals less than the invoice. The number that matters is the one the
provider kept.
