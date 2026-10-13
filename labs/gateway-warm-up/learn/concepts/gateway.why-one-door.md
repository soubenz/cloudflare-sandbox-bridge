---
id: gateway.why-one-door
title: Why every call goes through one door
order: 2
minutes: 2
recap: With one door, the provider keys live in one place, the provider is chosen in one place, and every call is written down in one record.
---
The six problems in the story share one cause. Each app called its provider directly, so each app had to do everything itself. This is that picture.

::diagram[gateway-no-door]

Every arrow carries a provider key, and every app has a provider's name in its code. Nothing sits between the apps and the providers, so nothing sees all the calls.

Put one door in the middle, a gateway, and three things move out of the apps and into it.

**The keys live in one place.** The gateway holds the provider keys. Each app gets its own key for the gateway instead, and the platform team can switch one off without touching any other app. A screenshot of an app's settings no longer shows a key that spends on a provider account.

**The provider is chosen in one place.** An app asks for a plain name, such as `support`. That name is an alias: Larkfield's own name for a job, not a provider's model name. The gateway's table says which provider and which model the alias means today. When a provider goes down at three in the morning, or renames a model on a Sunday, someone changes one line in that table. No app is rewritten, and every app that asks for `support` moves at once. The same line is how you try a better model.

**Every call is written down once.** Because every call passes through the gateway, it can record each one: which team, which alias, which provider, how many tokens. That record answers Finance's question about the invoice, and it is where a limit can stop a script that retries all weekend.

Next: what a gateway is not, so you do not expect it to do things it does not do.
