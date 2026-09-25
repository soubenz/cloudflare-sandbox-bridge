"""The run loop: one customer turn at a time, each one replied to and filed."""

from .case import load_case
from .config import CASE_FILE, PROMPT_BUDGET_TOKENS
from .desk import file_no_reply, file_reply
from .model import reply as model_reply
from .tokens import count_messages
from .transcript import Transcript
from .window import pack


def run(case_path=None):
    case_path = case_path or CASE_FILE
    case = load_case(case_path)
    turns = case["turns"]
    print("desk: case %s, %s (%s), %d turn(s) from %s" % (
        case["case_id"], case["customer"]["name"], case["customer"]["company"],
        len(turns), case_path))

    convo = Transcript(case)
    sent = 0
    unanswered = 0
    biggest = 0

    for turn in turns:
        convo.add_turn(turn)
        messages = pack(convo)
        estimate = count_messages(messages)
        biggest = max(biggest, estimate)
        print("  %s  %d message(s) sent, ~%d token(s)" % (
            turn["id"], len(messages), estimate))

        try:
            text = model_reply(case, turn, messages)
        except Exception as err:  # noqa: BLE001 - one bad turn must not end the case
            file_no_reply(case, turn, "the desk could not get a reply: %s" % err)
            unanswered += 1
            print("    no reply: %s" % err)
            continue

        convo.add_reply(turn, text)
        file_reply(case, turn, text)
        sent += 1
        print("    replied (%d chars)" % len(text))

    print("")
    print("desk: %d reply/replies sent, %d turn(s) left unanswered" % (sent, unanswered))
    print("desk: biggest request ~%d token(s) against a prompt budget of %d"
          % (biggest, PROMPT_BUDGET_TOKENS))
    print("desk: the context service has the record of what was actually sent;"
          " this line is only my own estimate of it.")
    return 1 if unanswered else 0
