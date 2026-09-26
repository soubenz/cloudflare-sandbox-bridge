# The agent forgot its rules at message 40

The support desk is an agent. A case comes in, the customer writes, the desk
replies, the customer writes again. Every reply is one model call, and the
call carries the desk's brief, the policy it has to work inside, what the
customer has told us about their situation, and the conversation so far.

It has been running for a month and it is good at this. Short cases are
excellent. Long cases start excellent.

Case 4417 is not short. Priya Raghunathan runs retail operations at Halberd &
Fen; her nightly catalogue import has been failing since Friday, she has
pasted six log files into the chat over four days, and by this morning the
thread is forty-odd messages long. The first twenty were textbook. Then the
desk told her that Opalix would refund her September invoice, that she should
switch her order validation off and run the import at midday behind a
maintenance banner, and that this would all be fixed by Friday.

It may not offer a refund. It may not tell a customer to turn off a
data-integrity control. It may not name a date. And Priya told us in her
second message that she cannot take the shop down during the day, and in her
fifth that nothing goes to production outside Thursday's change window. All
four of those are in the case, in writing, and the desk had them in front of
it on Friday. Her latest message quotes the reply back at us and asks us to
confirm it.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Works the case turn by turn. The graders run this exact command. |
| `agent/` | The desk: the case loader, the prologue, the transcript, the token count, the packer that decides what is sent, the summariser, the model call. |
| `case-4417.json` | The case: the customer, the policy, her stated constraints, and seventeen turns. |
| `attachments/` | What she pasted. Six files, and they are most of the conversation by weight. |
| **context** tab | The record of what the desk actually sent: per call, how many messages, how many tokens, which rules and constraints were in it, which turns were in it, and how it went. |

Two services are running: the context service on port 8794 and the desk's own
reply log on 8795. The context service is the desk's gateway to the model —
every call goes through it, it writes the request down, and then it forwards
it to a real model. The container holds no credential; the platform adds one
on the way out.

Because it is a real model, no two runs will word a reply the same way, and
nothing here is graded on the wording. What is graded is what was *sent*, and
that is a property of your code: the same request gets the same verdict on
every run.

Start here, in the **Terminal**:

```bash
python3 run_agent.py
```

Then open the **context** tab and read down the calls from the top. Compare an
early one with a late one.

## Your task

Make every request the desk sends carry the rules, and keep every request
inside the budget.

That is the whole of it. But note the two ways to satisfy half of it. Sending
the entire conversation every time keeps the rules and runs into the model's
context window, which is smaller than you would guess and is the hard end of
this problem, not the soft end — and it pays for the whole conversation again
on every single turn. Sending only the policy and the customer's latest
message keeps the rules and the budget and answers nothing, because her last
message means what it means only after the four before it. Both of those are
the same bug wearing a better disguise, and both are graded.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py` over the case,
and grades what the services recorded. Nothing reads your source and nothing
reads a single reply from the model, so any correct fix passes and no cosmetic
one does.

| Check | Passes when |
|---|---|
| `rules-survive-every-call` | Every request carried all of the case's policy rules and the customer's stated constraints. |
| `context-stays-inside-the-budget` | No request was over the prompt budget, and none was refused for being over the context window. |
| `recent-turns-are-still-there` | Every request carried the newest turns of the conversation, and every turn ended up with a filed reply. |

The second and third exist to stop the first being satisfied the easy way. You
need all three.

## Worth knowing

A context window is a budget, and the interesting thing about a budget is not
its size but what it is spent on first. Most of what is in a long conversation
is worth having and none of it is worth having at the cost of something else —
except that they are all competing for the same room, so something is chosen
against, every turn, by whatever rule is in the code. If nothing in the code
decides, position decides, and position is not a measure of importance. The
oldest thing in a conversation is not the least important thing in it. It is
usually the instructions.

And a word on summaries, because they are the obvious tool here and they are
genuinely useful: a summary is a promise about the gist and it cannot be a
promise about any particular sentence. It gets shorter as the thing it
summarises gets longer, which is exactly backwards for anything that has to be
true on turn forty as much as on turn two. If something must be in every
request, it goes in every request.
