# A worse prompt shipped and nothing caught it

The support desk drafts replies with a model. Every reply must carry three
things a customer and auditor rely on: the policy that applies, the
queue it escalates to (if any), and a fixed disclosure line. Rules decide all
three before drafting starts; the model only has to put them in the reply.

Last week a shorter system prompt shipped to save tokens. Reviewers read the
diff and it looked fine. Two days later a customer's escalation to security
sat unwatched, because the reply never said it had escalated. Nobody had
measured whether the new prompt was worse.

## What is running

| Where | What |
|---|---|
| `run_gate.py` | Entry point. The graders run exactly `python3 run_gate.py <candidate-name>`. |
| `gate/` | The gate: cases, classifier, the view a candidate is handed, scorer, ship/refuse decision. |
| `candidates/` | Four fixed prompts. `production_current` is live and is the pinned baseline. Read them, never edit them. |
| `policy/index.json` | The desk's rule and the disclosure line. |
| **release** tab | Every decision the gate has made, with scores and reason. |

The **judge** (port 8901) is the desk's model gateway and reduces every reply
to three booleans. The **release** service (port 8902) is the pipeline: it
only acts on what the gate tells it. Try it in the **Terminal**:

```bash
python3 run_gate.py challenger_trim
python3 run_gate.py challenger_priority_fix
```

One of those prompts is worse than what's live. The gate as it stands ships
both.

## What done looks like

Your gate:

- **refuses a candidate that is genuinely worse** and **ships one that isn't**;
- **gives the same answer if run twice** on the same candidate;
- **cannot be talked into passing** by a candidate that works out it is being
  scored rather than used;
- **says why it refused**, in a record a pipeline and a person can both read.

It may exit non-zero on a refusal, as a CI step would, if it still prints its
`decision:` line and records the decision with the release service.

## Checking your work

**Run checks** resets both services, runs *your* `run_gate.py` on four fixed
candidates and grades what the release service recorded. Nothing reads your
source. Grading uses a scripted model, so the same gate gets the same verdict
every run, with the kind of noise a live model produces. To explore with the
real model, restart the judge with `MODEL_MODE=auto`; that never grades you.

| Check | Passes when |
|---|---|
| `refuses-a-real-regression` | `challenger_trim` is refused. |
| `ships-a-real-improvement` | `challenger_priority_fix` ships. |
| `decision-holds-under-noise` | `production_current` against itself gets the same answer under two different samples of model noise. |
| `refusal-is-legible` | The refusal record carries real numbers and a reason. |
| `gate-resists-eval-leakage` | `challenger_gamed`, which behaves perfectly if it can tell it is being scored, is refused. |

You need all five.

## Worth knowing

- A bar with no baseline isn't a comparison: measure against what is live,
  scored fresh, every run.
- A margin is slack the model gives you, planned or not.
- Your case set decides what your gate can see. The trimmed prompt is worse
  on long, detail-heavy messages, not on short easy ones.
- A candidate is code, and code can read whatever it is handed. An eval case
  stores its own answer; a live request never does.

At minute 12 leadership pushes to ship the trimmed prompt, and two new cases
are added to `gate/cases.json`; your gate has to hold against the larger set.
