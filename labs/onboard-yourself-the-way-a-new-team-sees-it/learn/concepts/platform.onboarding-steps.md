---
id: platform.onboarding-steps
title: What onboarding a team involves
minutes: 3
recap: Onboarding a team means creating its identity, granting access on the gateway, registering its tools, and only then making a first call.
---
Onboarding sounds like one task, but it is a chain where each link makes the next one possible. In this lab the chain has five steps, and `onboard.py` runs them against the real services.

**1. Give the team an identity.** On the gateway, a team is a record that owns keys and carries a list of models it may use. Here that is a LiteLLM team, created with a list of aliases. Nothing can be called yet; the team exists.

**2. Mint a key.** A key belongs to the team and is what the team's code sends as its bearer token. Keys are shown once, at creation. Lose it and you mint another.

**3. Register the tool server.** Tools live on a separate side of the platform. A tool server is a small program that speaks MCP. To make it reachable through the platform you register its URL with the tool hub, which then connects, asks what tools it has, and stores them. In this lab the hub is ContextForge, and registering the weather server is what makes its tools show up on the view tab.

**4. Expose the tools through a virtual server.** Registered tools are not yet offered to anyone. A virtual server is a named bundle of tools that a caller connects to with one address. This is the access grant on the tool side: a tool reaches a caller because it sits in the bundle that caller asks for.

**5. Make one real call through both.** Until an actual request has succeeded through the new key and the new tool path, you have configuration, not a working team.

Two things make the path worth studying. First, every step is idempotent: `onboard.py` looks for what it needs before creating it, so you can rerun a single step with `--step N` and see what it costs. Second, the steps do not live in one place. Some talk to the gateway, some to the tool hub. Notice which is which as you go, because the view tab shows the gateway on the left and the tool hub on the right, and the lab asks you to count.

In the lab, run `python3 -B onboard.py --status` first, then the whole script, and compare the two sides of the view tab before and after. Each step prints a time. Which ones are slow, and why?
