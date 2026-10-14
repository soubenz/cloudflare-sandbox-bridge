---
id: gateway.what-is-a-gateway
title: What an LLM gateway is and why teams run one
order: 1
minutes: 3
recap: An LLM gateway is one front door between your apps and model providers. It holds the keys, routes by alias, logs tokens and cost, and can fall back.
---
An LLM gateway is a service that sits between your apps and the companies that run language models. Apps send every request to the gateway, and the gateway forwards it to a real provider. Think of a hotel reception desk. Guests never walk into the kitchen or the storeroom. They ask the desk, and the desk knows who to call, holds the master keys and writes down what was used.

::diagram[gateway-what-it-does]

Each problem in the story is one that a single front door removes:

- **Keys pasted into repos and chats.** Only the gateway holds provider keys.
- **The 3am outage.** Callers name no provider, so the gateway can send the call to another one.
- **The renamed model.** Apps send a stable name, so a rename is fixed in one table, not in three codebases.
- **The invoice nobody can read.** Every call passes through, so one log can show who asked, how many tokens and what it cost.
- **The weekend loop.** One door is the one place to cap or alert on spend.

On every call the gateway does the same six things:

1. Receives the request, with an alias in the `model` field.
2. Checks the key the caller sent.
3. Routes: looks the alias up and picks a deployment.
4. Calls the upstream provider with its own credentials.
5. Records the usage: tokens (the small pieces of text a provider counts and bills by), and cost from a price.
6. Returns the answer, or a clear error.

So the shape is callers, then gateway, then providers. Callers never reach a provider directly.

Five terms that come back in every gateway lab:

- **Alias:** the stable name a caller sends, such as `support`.
- **Deployment:** one concrete place a model runs, at one provider.
- **Key:** the credential a caller shows to prove who it is.
- **Spend log:** the gateway's table of calls, one row each.
- **Upstream provider:** the service behind the gateway that actually runs the model.

The next lesson looks closer at why one door helps. In the first lab you then send calls to a real gateway and compare what it says happened with what the provider recorded.
