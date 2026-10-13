---
id: gateway.what-it-is-not
title: What a gateway is not
order: 3
minutes: 2
recap: A gateway is not a model, not a cache and not a firewall. Every call still goes to a real provider, which runs the model and sends the bill.
---
A new idea is easy to mix up with ones you already know. Three are worth ruling out.

**It is not a model.** A gateway runs no model of its own and writes no answers. It passes the request to a provider, and the provider's model writes the answer. If the answer is wrong, the model got it wrong; the gateway only carried it.

**It is not a cache.** A cache keeps earlier answers and hands them out again without asking anyone. A gateway sends every call on to a provider, so every call is counted and paid for. Some gateways can add a cache as an extra feature, but that is something a team switches on, not what a gateway is.

**It is not a firewall.** A firewall decides which network traffic may reach your servers. A gateway checks that a caller's key is allowed in and can refuse a call that goes over a limit, but it does not watch your network or protect your servers.

The call still goes to a real provider. Look at the path of one call again.

::diagram[gateway-what-it-does]

The provider still runs the model, still counts the tokens and still sends Larkfield the invoice. The gateway adds one stop on the way: it holds the provider key, picks which provider gets the call and writes down what happened. If every provider behind it is down, the gateway cannot answer either. It can only report the failure clearly.

After this lesson come a few more questions, then the closing story and four short games.
