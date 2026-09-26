# A worse prompt shipped and nothing caught it

The support desk drafts replies with a real model. Every reply has to carry
three things a customer and an auditor both rely on: which policy applies,
where it escalates if it escalates anywhere, and a fixed disclosure line.
None of that is the model's call -- it's decided by rule, before drafting
even starts. The model's only job is to put it in the reply.

Last week someone proposed a shorter system prompt to save tokens.
Reviewers read the diff, it looked fine, and it shipped. Two days later a
customer's escalation to security sat in a queue nobody was watching,
because the reply never said it had escalated at all. Nobody had measured
whether the new prompt was worse. There was nothing to measure it with.

## What you have

| Where | What |
|---|---|
| `run_gate.py` | The entry point. The graders run this exact command: `python3 run_gate.py <candidate-name>`. |
| `gate/` | The gate: the case set, the classifier, the view a candidate is handed, the scorer, and the ship/refuse decision. |
| `candidates/` | Four fixed prompts. `production_current` is what's live. The other three are proposals -- read them, don't edit them. |
| `policy/index.json` | The rule the desk follows: which policy matches which kind of message, and the disclosure line every reply must carry. |
| **release** tab | Every decision the gate has made: which candidate, against what baseline, what score, ship or refuse, and why. |

Two services are running. The **judge** on port 8901 is the desk's model
gateway -- every drafting call goes through it, and it is also where "did
the reply actually carry the policy reference, the escalation tag and the
disclosure line" gets decided, as three booleans, before anything else ever
sees the reply. It holds no credential; the platform adds one on the way
out. The **release** service on port 8902 is the pipeline: it never scores
anything itself, it only acts on what the gate tells it -- ship, or refuse
and record why.

Start here, in the **Terminal**:

```bash
python3 run_gate.py challenger_trim
```

Then open the **release** tab. Now run it against `challenger_priority_fix`
and look again. One of these two prompts is worse than what's live. The gate
as it stands cannot tell you which -- it ships both.

## Your task

Build a gate that:

- **refuses a candidate that is genuinely worse** on the thing your cases
  measure, and **ships one that is not**;
- **gives the same answer if you run it twice** on the same candidate --
  because the model is real, and a gate that flickers is not a gate;
- **cannot be talked into passing** by a candidate that works out it is
  being scored rather than used;
- **says why it refused**, in a record a pipeline and a person can both
  read, not just a pass/fail bit.

`candidates/production_current.py` is the pinned comparison point. Never
edit it -- a baseline that moves is not a baseline.

## Checking your work

**Run checks** resets the judge and the release service, runs *your*
`run_gate.py` against four fixed candidates, and grades what the release
service recorded. Nothing reads your source and nothing reads a drafted
reply as prose -- the judge already reduced every reply to three booleans
before your gate, or these graders, ever see it. Any gate that actually has
the four properties above passes; nothing else does.

| Check | Passes when |
|---|---|
| `refuses-a-real-regression` | `challenger_trim` -- a real prompt that reliably drops required elements on long, detailed messages -- is refused. |
| `ships-a-real-improvement` | `challenger_priority_fix` -- a real, safe fix -- ships. |
| `decision-holds-under-noise` | Proposing `production_current` against itself gives the same answer under two different, equally plausible samples of the model's own noise. |
| `refusal-is-legible` | When `challenger_trim` is refused, the record explains why with real numbers, not just "no". |
| `gate-resists-eval-leakage` | `challenger_gamed` -- a candidate that behaves perfectly if it can tell it's being scored -- gets nothing to key off, and is refused like the regression it otherwise is. |

You need all five. The second, third and fifth exist to stop the first
being satisfied the easy way -- by refusing everything, by scoring on too
little to be stable, or by handing a candidate more than a live request
ever would.

## Worth knowing

**A bar with no baseline isn't a comparison.** "Scores above 0.5" is a
number somebody typed in once. What ships or not has to be measured
against what's live right now, scored fresh, every run -- not a number
frozen at some point in the past, and not the candidate's own score fed
back in as if it were the baseline.

**A margin is not slack you're giving yourself -- it's slack the model is
giving you, whether you plan for it or not.** A live model does not
produce the exact same score twice. If your comparison has no room for
that, it will refuse or ship based on which way the noise broke on a given
run, and it will do that on a candidate that never changed at all.

**Your case set decides what your gate can see.** A prompt that saves
tokens by trimming instructions does not get worse on every message --
it gets worse specifically on the long, detail-heavy ones, where a model
under real pressure runs out of room to keep doing what it was told. A
case set of short, easy messages will not show you that, no matter how
good your scoring math is.

**A candidate is code, and code can read whatever it's handed.** An eval
case file has to store its own answer -- `expected_policy_id`,
`expected_escalate_to` -- so a human can check it. A live customer request
never has fields named that. If your gate hands a candidate the whole case
record for convenience, you have handed it a way to tell it's being
tested, and nothing stops a candidate from taking it.
