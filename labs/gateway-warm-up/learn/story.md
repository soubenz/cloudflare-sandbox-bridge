---
title: Six things went wrong
minutes: 2
---
Six things went wrong at one company last month. Four of them will happen to yours.

Saturday, 03:12. Larkfield's support assistant stopped answering customers. Its model provider, the company that runs the model it uses, was down. Another provider was working, but the first one's name was written into the app's code.

At 03:40 Tomasz, an engineer on the platform team, was still rewriting that code by hand to point at the other provider. Tomasz: "I've done good work at three a.m. This isn't it."

Every app at Larkfield talks to a language model. Each app picked its own provider and holds its own key. A key is the secret that proves who is paying: anyone who has it can make calls, and the bill goes to its owner.

Tuesday, 10:05. Ollie, a developer, shared a screenshot in the team chat to show off a good answer. Ollie: "Look at this answer! Best one yet." A provider key was in the corner of it. Maren, who leads the platform team: "Ollie. Bottom corner. That's our provider key."

Friday evening, a research script got an error and sent the same call again. It kept sending it until Monday morning. By then it had spent the whole month's budget. Ollie, who wrote the script: "In my defence, the error did say try again."

Sunday, a provider renamed one of its models. Three apps had the old name typed into their code, and all three stopped working. Tomasz: "They renamed it. On a Sunday."

At the end of the month one invoice arrived, with one number on it. Finance asked which team had spent it, and with which provider. Graham, the head of engineering: "Which team spent this? And with whom?" Nobody could say. Maren: "I've practised the shrug. It's very good now."

Then a better model came out, faster and cheaper. Nobody tried it, because trying it meant changing every app that would use it. Jess, a product manager: "It's faster AND cheaper! Can we try it today?" Tomasz: "Sure. In every app. By hand."

Six beats, stacked on a black card: a rewrite at three in the morning, a key in a screenshot, a weekend of retries, a renamed model, one invoice, a model nobody tried. For each one, decide: is this normal, or a sign that something is missing?
