---
title: One door for the tools
minutes: 2
---
Priya Nair catches you at the coffee machine on Thursday morning. Her Support team wants its assistant to look up why a parcel is late, and the answer starts with the weather in the depot's city.

"Search wrote a weather lookup last quarter," she says. "Billing wrote their own calculator. Each one is wired into its own agent in its own way, and I do not want a fifth way. Security told Maren they want one door: agents reach tools through one place, and that place knows what was called."

Maren Osei joins as you reach your desk. "That door is a tool gateway," she says. "We have set one up with two toy tool servers behind it, a weather one and a calculator. The agent side of this is a protocol, not a library. Agents ask a server what tools it has and then call them by name. Before Priya's team writes any code against it, I want you to see it from an agent's side."

She points at the terminal. "There is a script that sends the same requests an agent would and prints both directions. Look at what a tool server hands over, what the gateway exposes to an agent, and what comes back when a call goes right and when it does not. Priya's assistant will read those answers, so the shape of a failure matters as much as the shape of a success."

She leaves you with three questions. One is a count of what the agent can see. One is a small sum. The last is about what a call to something that does not exist looks like to an agent, and she has warned you the HTTP status will not settle it.

"Take the time to look at the request bodies," she says. "People skip them and regret it."
