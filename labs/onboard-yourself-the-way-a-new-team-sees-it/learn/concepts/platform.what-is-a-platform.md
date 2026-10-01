---
id: platform.what-is-a-platform
title: What an AI platform gives a team that a pile of services does not
minutes: 3
order: 1
recap: An AI platform is shared services run by one team, with one front door, a key per team, shared tools, shared logs and cost, and a standard way to join.
---
A new team starts on Monday. Before you walk their checklist, here is what they are joining and why a checklist exists at all.

**Without a platform.** Every team that wants a model does the same chores alone: pick a provider, open an account, keep the key in its own repo, wire up its own tools, and find out at the end of the month what it spent. Four teams do that four times. You get four keys nobody can list, four bills, four sets of logs, and no one who can say what happened to a request.

**What an internal AI platform is.** It is a small set of shared services, run by one team, that product teams use instead of going to providers directly. At Larkfield it gives each team:

- **One front door.** The **gateway** is a single address. A team asks for a model by **alias**, a stable name such as `fast-draft`, and the gateway decides which model answers.
- **A key per team.** Each **team** is a record on the gateway with its own key. The key has a **scope**: the list of aliases it may call. Anything off the list is refused, and one team's key can be revoked without touching the others.
- **Shared tools.** A **tool server** is a small program offering things an agent can call, such as a weather lookup. The **tool hub** puts them behind one address and offers each team only the tools bundled for it.
- **Shared logs and cost.** Every call through the front door leaves one record: who, which model, how many tokens. "Who spent this?" has one place to look.
- **A paved road.** A standard path that always works for joining all of the above, so a team does not rediscover it from a wiki.

::diagram[platform-what-is-a-platform]

**Onboarding** is adding a team to the platform. It creates the team's record and key on the gateway, registers its tools with the hub, and proves a first real call works. The steps live in more than one system, which is why they are easy to get wrong and slow to do by hand.

**Words this lab uses**

- **Team**: the unit that owns keys and a list of allowed aliases.
- **Key scope**: the aliases a key may call.
- **Alias**: the stable name a team calls instead of a provider model.
- **Tool server**: a program that offers tools to agents. The tool hub fronts it.

**In the lab.** You play the new team. Run the onboarding script step by step, watch the view tab before and after, and note which system each step touches and how long it takes. The steps that cost time are where the platform could do better.
