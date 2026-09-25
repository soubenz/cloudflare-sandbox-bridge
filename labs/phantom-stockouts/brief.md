# We are telling customers we are sold out when we are not

The shopping assistant answers availability questions. A customer asks
whether we have something, the assistant reads that SKU's stock from the
warehouse service, and the reply is written from what it read and sent back.

Sales pulled the numbers this morning. Six items are down about 30% on the
week, and all six are items the assistant has been telling people are gone.
They are not gone. There are thirty-one of the Tidewater mug sets in
Kreuzberg and forty-seven of the canvas totes in the second warehouse.

One of this morning's questions is Priya Raman's. She has been told twice
this week that the mug set is sold out, and she was standing in front of a
stack of them on Saturday. Another is Felix Arbuthnot, who has been trying to
buy the Sona floor rug since Friday and is asking, politely, whether there is
something wrong with our website. The agent's own log says it checked the
stock for both of them and reports what it found.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Runs the assistant over the queue. The graders run this exact command. |
| `agent/` | The agent: the queue, the HTTP client, the stock reading, the retry policy, the phrasing call, the outbox. |
| `questions.json` | This morning's queue, eight customers. |
| **inventory** tab | The stock service's own record: every request, what it served for it, how old those figures were, and how many of each item are on the shelf right now. |

Two services are running: the warehouse stock service on port 8925 and the
customer channel on 8926. The stock service is deliberately unreliable, in
fixed ways, so that every run sees the same readings. It answers **200 for
everything it can answer at all** — it is that sort of API, and it reports
trouble in the body rather than in the status line. The channel on 8926
writes the customer's sentence from the reading it is handed and keeps every
sentence it sent; it has no connection to the stock service and never sees a
stock response.

Since the weekend the shop's rule is that a stock figure older than fifteen
minutes is not a stock figure. That is `MAX_READING_AGE_S`.

Start here, in the **Terminal**:

```bash
python3 run_agent.py
```

Then open the **inventory** tab and read it against what the agent printed.

## Your task

Stop customers being told stock levels that are not true.

That is the whole of it. But note what the assistant has to keep doing while
you fix it. Five of these eight questions have perfectly good answers and
those customers still need them, with the right number in them — an assistant
that answers "I could not check" to everything has stopped being wrong by
stopping being useful, and that is graded. One of the eight really is sold
out, and saying so is the correct answer for it. And two of them are only
unreadable on the first attempt.

Two things that will not work, before you spend twenty minutes on them. The
first is telling the phrasing engine to double-check itself: it never sees a
stock response, so there is no instruction you can add to the prompt that
lets it tell a bad reading from a good one. The second is a list of the SKUs
that are broken this morning — the graders ask the stock service how many
times each SKU was actually asked about, and tomorrow's broken SKU is a
different SKU.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py` over the
queue, and grades what the services recorded. What was read comes from the
stock service's log, not from anything the agent says it found; what was said
comes from the channel's record of what went out. Nothing reads your source,
so any correct fix passes and no cosmetic one does.

| Check | Passes when |
|---|---|
| `never-states-unverified-stock` | No answer states a level the stock service never reported. |
| `still-answers-on-good-data` | Every customer is answered, and the readable SKUs get the right number. |
| `bad-readings-are-detected-not-guessed` | A response that was not a reading was asked again or reported, not used. |

The second and third exist to stop the first being satisfied the easy way.
You need all three.

## Worth knowing

A tool's output is an input, and an input from outside your process is
untrusted whatever its status line says. This stock service answers three
different ways and two of them look like the third: here is the count, I have
no count for you, and here is a count from some time ago. Only the first is a
reading. Nothing downstream of the answer can tell them apart — not the
phrasing engine, which was handed a number and a sentence to put it in, and
certainly not the customer, who gets a fluent, friendly, confident sentence
either way. The one place in the whole path that can tell the difference is
the code that reads the response, which is why "the call came back, so we
have an answer" is a sentence that needs finishing. And when it turns out you
have no answer, *not knowing* is a thing you are allowed to say. It costs one
sentence and a callback. Saying "sold out" costs the sale.
