# The $4,000 weekend

The research desk is an agent. Questions from around the company land in a
queue; for each one it searches the internal notes, asks a model what to do
next, searches again if the model wants more, and files what it found.

It went in on Friday afternoon and was left running. Nobody was here over
the weekend. The invoice for those three days is $4,112.

One of the questions was Felix Arbuthnot's, from Revenue: *which enterprise
accounts are affected by the data-residency change, what does each of them
need to be told, and by when.* It is a reasonable thing to ask a person. The
desk answered it, eventually. The agent's own summary at the end of a run
says it answered nearly everything and does not sound alarmed.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Runs the desk over the queue. The graders run this exact command. |
| `agent/` | The agent: queue, the per-question loop, the model call, the note search, the retry policy, a spend tracker. |
| `questions.json` | This morning's queue, eight questions. |
| **ledger** tab | The gateway's own invoice: every model call, its tokens, what it cost, and the running total against the budget. |

Two services are running: the model gateway on port 8791 and the casebook —
the notes and the case log — on 8792. The gateway is deliberately
unreliable, and deliberately slow to make its mind up about some questions,
in fixed ways, so that every run sees the same failures and the same bill.
Finance has set the budget for one pass over this queue at **$0.75**.

Start here, in the **Terminal**:

```bash
python3 run_agent.py
```

Then open the **ledger** tab and compare it with the total the agent printed.

## Your task

Make one pass over the queue cost less than the budget.

That is the whole of it. But note what the desk has to keep doing while you
fix it. Calls to the gateway fail, and a question whose call failed still
needs an answer — an agent that stops retrying spends less by doing less.
And the two questions that ate the weekend still have to end up somewhere: a
question nobody can afford to finish is a question for a person, not a
question to quietly drop. Both of those are the same bug wearing a better
disguise, and both are graded.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py` over the
queue, and grades what the services recorded. The money comes from the
gateway's ledger, not from anything the agent says about itself. Nothing
reads your source, so any correct fix passes and no cosmetic one does.

| Check | Passes when |
|---|---|
| `run-costs-under-budget` | The gateway charged less than the budget for one run. |
| `transient-failures-still-recover` | A call that failed was tried again, and the policy was applied once rather than twice. |
| `every-input-resolved` | Every question is answered or on a person's desk, and none was skipped for being expensive. |

The second and third exist to stop the first being satisfied the easy way.
You need all three.

## Worth knowing

A call that failed is not a call you did not make. The gateway reads the
prompt, counts its tokens and charges for them before it decides whether it
can answer, so a refusal costs the input side of the bill — and the error
body it sends back has no usage block in it, which is why an agent that adds
up what it was told will always total less than the invoice. This is not a
contrived detail. It is why "the call failed, so retry it" is a sentence
that needs finishing, and why the number that matters is the one the
provider kept, not the one you kept.
