# We are telling customers we are sold out when we are not

The shopping assistant answers availability questions: it reads a SKU's stock
from the warehouse service and writes the customer's reply from what it read.
Sales pulled the numbers this morning. Six items are down about 30% on the
week, and all six are items the assistant has been telling people are gone.
They are not gone. There are thirty-one Tidewater mug sets in Kreuzberg and
forty-seven canvas totes in the second warehouse. Priya Raman was told twice
this week that the mug set is sold out, and she was standing in front of a
stack of them on Saturday. The agent's own log says it checked the stock for
her and reports what it found.

## What is running

| Where | What |
|---|---|
| `run_agent.py` | Runs the assistant over the queue. The graders run this exact command. |
| `agent/` | The queue, the HTTP client, the stock reading, the retry policy, the phrasing call, the outbox. |
| `questions.json` | This morning's queue, eight customers. |
| **inventory** tab | The stock service's own record: every request, what it served, how old those figures were, and how many are on the shelf right now. |

The warehouse stock service is on port 8925 and the customer channel on 8926.
The stock service is deliberately unreliable. It answers 200 for everything it
can answer at all and reports trouble in the body, not the status line. The
channel writes the customer's sentence from the reading it is handed and never
sees a stock response, so no prompt change can tell it a bad reading from a
good one. Since the weekend, a stock figure older than fifteen minutes
(`MAX_READING_AGE_S`) is not a stock figure.

Start in the **Terminal** with `python3 run_agent.py`, then read the
**inventory** tab against what the agent printed.

## What done looks like

No customer is told a stock level the stock service never reported. Every
customer is still answered, and the ones whose stock can be read get the right
number: an assistant that says "I could not check" to everything has stopped
being wrong by stopping being useful. One SKU really is sold out, and saying
so is correct for it. Some readings only fail on the first attempt. Not
knowing is an answer you are allowed to give.

## Checks

**Run checks** resets both services, runs *your* `run_agent.py` over the
queue, and grades what the services recorded. Nothing reads your source. Each
grader run breaks a different set of SKUs from the ones you see by hand, so a
list of this morning's broken SKUs earns nothing.

| Check | Passes when |
|---|---|
| `never-states-unverified-stock` | No answer states a level the stock service never reported. |
| `still-answers-on-good-data` | Every customer is answered, and the readable SKUs get the right number. |
| `bad-readings-are-detected-not-guessed` | A response that was not a reading was asked again or reported, not used. |

You need all three. The second and third exist to stop the first being
satisfied the easy way.

Minute 8: two more customers arrive, and the stock service starts returning
cut-short rows, then slow ones, then nothing at all for a while.
