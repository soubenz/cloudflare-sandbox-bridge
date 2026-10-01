---
id: gateway.error-semantics
title: What a gateway returns when it cannot serve a call
minutes: 3
order: 4
recap: A failed call gets an HTTP status that says whose fault it was (4xx caller, 5xx server side) and a JSON error body with a message.
---
The last step of every call is returning the answer, or a clear error. This lesson is about the error. A gateway has to say no sometimes, and how it says no matters to every client behind it. The HTTP status is the first signal, and its class carries the meaning.

::diagram[gateway-error-semantics]

A 4xx status means the request was wrong and sending it again unchanged will fail the same way. A malformed body, a missing credential, a name the gateway does not know: all caller problems. A 5xx status means the request may have been fine and something on the serving side failed, such as the provider being down or the gateway erroring. A retry with backoff is reasonable there, and a retry on a 4xx is a wasted call.

The status alone is not enough. LiteLLM copies the shape of the OpenAI API, so an error comes back as JSON with an `error` object, and its `message` field says in words what went wrong. Clients that already speak the OpenAI format can read it without special handling. That is the reason Larkfield wants every team behind one gateway: one error shape to write handling for, instead of four.

Two traps for engineers new to this. First, do not assume a failed call is free or invisible. Whether an error shows up in the spend log depends on how far the call got, so absence from a log is not proof that nothing was sent. Second, do not treat all errors as provider errors. A call that never leaves the gateway, because the alias does not exist, never touches the provider, and the provider's own log will show nothing for it.

That second point is a good way to tell where a failure happened. If a call fails and the provider's log has no new row, the gateway refused it. If the provider's log has a row and the caller still got an error, the failure came after the gateway forwarded it.

In the lab, `send_calls.py` prints the status and the error message instead of the usage lines when a call is not a success. Ask for an alias that is not in the config and read what comes back: the status, its class, and the message. Then check the provider's log in the **view** tab to see whether the call reached it.
