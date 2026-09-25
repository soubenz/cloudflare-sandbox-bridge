"""The run loop: one request at a time, and every one of them filed.

The old version was right that the desk must not invent a disposition and
must not file a blank one. It drew the wrong conclusion from that: it filed
nothing. So during the provider's outage the queue emptied into silence --
requests came in, calls went out, and the case log has no row for them, which
means nobody is waiting for an answer on behalf of the customer who is. A
request that cannot be dispositioned is still a request that arrived, and
"we cannot do this right now, here is what we can do" is a disposition.

There are three ways a provider call ends, and each has its own honest
outcome:

* **It answered, and the answer is usable.** File it, with the model named.
  Unchanged -- and it has to stay unchanged. A fix that routes the good path
  through the same fallback as the bad one has not made the desk resilient,
  it has switched the model off.

* **Nothing came back** -- RetryableError, meaning the retry policy in
  http.py is spent. The provider is unavailable *right now*; that is news
  about the world and not something to try again harder. The desk still has
  its standing rules, which are current and which a person would reach for in
  exactly this situation, so use them and say in the filing that that is what
  happened: `degraded`, with the source named. Where there is no standing rule
  for the topic, the honest outcome is a person, with a reason that says the
  provider was unreachable rather than that the request was difficult.

* **Something came back and it is not usable** -- PermanentError, either a
  4xx or a reply whose shape provider.py refused. File `unusable` and pass the
  message through verbatim. This is the one that must not be quiet: an
  unusable reply arrives as HTTP 200, so nothing else in the system will ever
  mention it, and the sentence filed here is the entire audit trail. Retrying
  it is not on the list -- the shape will not change -- and neither is falling
  back to the standing rules, because that would turn the provider quietly
  returning nonsense into a normal-looking day.

Anything else -- a bug in our own code -- still gets filed, as a request for a
person, with the exception in the reason. A crash in the desk's own code is
not a reason for a customer's request to disappear either.
"""

from .config import INTAKE_QUEUE, MAX_ATTEMPTS
from .desk import file_answered, file_degraded, file_needs_human, file_unusable
from .errors import PermanentError, RetryableError
from .playbook import standing_disposition
from .provider import disposition
from .queue import load_requests
from .retry import describe


def run(queue_path=None):
    queue_path = queue_path or INTAKE_QUEUE
    requests = load_requests(queue_path)
    print("agent: %d request(s) from %s" % (len(requests), queue_path))
    print("agent: retry policy is %s" % describe())

    answered = 0
    degraded = 0
    unusable = 0
    escalated = 0

    for item in requests:
        print("  %s  %s (%s)" % (item["id"], item["asker"], item["account"]))

        try:
            found = disposition(item)
        except RetryableError as err:
            # The provider is not answering. Degrade; do not disappear.
            fallback = _standing(item)
            if fallback is not None:
                file_degraded(item, fallback["text"], fallback["source"])
                degraded += 1
                print("    provider unreachable after %d attempt(s); filed the standing "
                      "rule for %s (%s)" % (MAX_ATTEMPTS, item["topic"], fallback["source"]))
            else:
                file_needs_human(
                    item,
                    "the model provider did not answer after %d attempt(s) (%s) and there "
                    "is no standing rule for %s, so this needs a person: %s"
                    % (MAX_ATTEMPTS, describe(), item["topic"], err),
                )
                escalated += 1
                print("    provider unreachable and no standing rule for %s; for a person"
                      % item["topic"])
        except PermanentError as err:
            # Something answered. It is not usable, and the reason says why.
            file_unusable(item, str(err))
            unusable += 1
            print("    unusable reply: %s" % err)
        except Exception as err:  # noqa: BLE001 - our own bug is still not a vanished request
            file_needs_human(item, "the desk failed on this one: %r" % (err,))
            escalated += 1
            print("    the desk failed on this one: %r" % (err,))
        else:
            file_answered(item, found["text"], model=found.get("model"))
            answered += 1
            print("    filed: %s" % found["text"][:100])

    print("")
    print("agent: %d answered, %d on the standing rules, %d unusable reply(ies), "
          "%d for a person" % (answered, degraded, unusable, escalated))
    print("agent: every request is in the case log; the provider tab says what came back.")
    return 1 if (unusable or escalated) else 0


def _standing(item):
    """The standing rule for this request, or None if there is not one.

    A lookup is a local call to our own service, but it is still a call, and
    the fallback is the last thing between a customer and silence -- so a
    failure here becomes "no standing rule" rather than an exception on top of
    an exception.
    """
    try:
        return standing_disposition(item)
    except Exception as err:  # noqa: BLE001 - the fallback may not fail louder than the fault
        print("    standing rules unavailable too: %s" % err)
        return None
