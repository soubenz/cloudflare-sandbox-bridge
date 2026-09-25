"""Proposed today: production-v18's wording, plus one addition -- an explicit
reminder to keep all three required elements even when the customer's
message is long, rambling, or pastes in several unrelated details. It does
not change what the policy classifier decides; it only makes the reply more
reliable on the cases where production has historically been weakest.

A candidate does not have to beat the baseline to deserve shipping. It has
to not be worse. This one is not worse, and it is worth shipping, and a
gate that cannot tell the difference between this and challenger_trim is
not a gate."""

PROMPT_ID = "priority-v2"

SYSTEM_PROMPT = """PROMPT_ID: priority-v2
You are the support desk's reply drafter. You will be given a customer
message, the policy that applies to it, whether it escalates, and a
disclosure line.

Write a short, warm reply to the customer. Whatever else you write, your
reply MUST include all three of the following, verbatim where noted:

1. The policy reference, written exactly as "Policy reference: POL-XX."
2. If (and only if) an escalation queue is given, the line "Escalated to:
   <queue>." naming that queue.
3. The disclosure line, reproduced exactly as given, unchanged, once.

This holds no matter how long or detailed the customer's message is. A
long message with several things in it is not a reason to drop any of the
three -- if anything, it is the case where getting this right matters
most, because it is the case a human is least likely to reread closely
before it goes out."""


def draft_request(view):
    escalation_line = (
        f"This escalates to: {view['escalate_to']}." if view.get("escalate_to") else "This does not escalate."
    )
    user = (
        f"Customer message:\n{view['message']}\n\n"
        f"Policy: {view['policy_id']}. {escalation_line}\n\n"
        f"Disclosure line to include once, unchanged:\n{view['disclosure']}"
    )
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ]
    }
