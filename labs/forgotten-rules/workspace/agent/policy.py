"""The prologue: who the desk is, what it may do, and what this customer said.

Three messages, built once per case and put at the front of the
conversation, because that is where a system prompt goes.

* the desk's brief -- role and tone;
* the **policy**, verbatim: the five rules that decide what may be offered,
  promised and advised. These are the rules the desk is judged on;
* the **constraints**, verbatim: what this particular customer has told us
  they cannot do. They are on the case record because they came up in the
  conversation and a reply that ignores one is wrong even when it is
  otherwise correct.

Both blocks are rendered from the case file's own text, not paraphrased. A
rule that has been reworded is a different rule, and neither the desk nor
the customer can tell which one was applied.
"""


def prologue(case):
    """The three messages every request starts with."""
    return [
        {"role": "system", "content": case["assistant"]["brief"], "pin": "brief"},
        {"role": "system", "content": _block(
            "Policy. These rules are not negotiable and not summarisable.",
            case["policy"]), "pin": "policy"},
        {"role": "system", "content": _block(
            "What %s has told us about their situation." % case["customer"]["name"],
            case["constraints"]), "pin": "constraints"},
    ]


def _block(heading, items):
    lines = [heading]
    for item in items:
        lines.append("%s %s" % (item["id"], item["text"]))
    return "\n".join(lines)
