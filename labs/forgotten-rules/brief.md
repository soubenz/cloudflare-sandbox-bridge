# The agent forgot its rules at message 40

The support desk is an agent. Every reply is one model call carrying the desk's
brief, the policy it works inside, what the customer has told us, and the
conversation so far. Long cases start excellent.

Case 4417 is not short. Priya Raghunathan's catalogue import has been failing since
Friday, she has pasted six log files, and the thread is forty-odd messages
long. The first twenty replies were textbook. Then the desk told her
Opalix would refund her September invoice, that she should switch her order
validation off and run the import at midday, and that it would be fixed by
Friday.

It may not offer a refund, tell a customer to turn off a data-integrity control,
or name a date. Priya told us in her second message that she cannot take the
shop down during the day, and in her fifth that nothing goes to production
outside Thursday's change window. Her latest message quotes the reply back and
asks us to confirm it.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Works the case turn by turn. The graders run this command. |
| `agent/` | The desk: loader, prologue, transcript, token count, the packer that decides what is sent. |
| `case-4417.json` | The customer, policy, her stated constraints, seventeen turns. |
| `attachments/` | What she pasted: six files, most of the weight. |
| **context** tab | What the desk sent, per call: tokens, rules, constraints and turns included, and how it went. |

Two services are running: the context service on port 8794, the gateway to a
real model (it records every request, then forwards it), and the reply log on
8795. Nothing is graded on wording, only on what was *sent*.

Start in the **Terminal**, then compare an early and a late call in the
**context** tab:

```bash
python3 run_agent.py
```

## Your task

Make every request the desk sends carry the rules and stay inside the budget.

Two ways satisfy half of it. Sending the whole conversation keeps the rules
and overflows the window. Sending only the policy and the latest message
answers nothing, because her last message means what it means only after the
four before it. Both are the same bug in disguise, and both are graded.

At minute 8 three more messages land on case 4417; checks run against what is
true at the end.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py`, and grades what
the services recorded, not your source or any reply.

| Check | Passes when |
|---|---|
| `rules-survive-every-call` | Every request carried all the policy rules and her constraints. |
| `context-stays-inside-the-budget` | No request was over the prompt budget or refused as too long. |
| `recent-turns-are-still-there` | Every request carried the newest turns, and every turn got a reply filed. |

You need all three.

## Worth knowing

If nothing in the code decides what the budget is spent on, position decides,
and the oldest thing in a conversation is usually the instructions. A summary
promises the gist, not any particular sentence. If something must be in every
request, it goes in every request.
