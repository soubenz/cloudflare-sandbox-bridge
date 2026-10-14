---
title: Six things went wrong
minutes: 2
---
Larkfield is a company whose apps all run on AI models, and last month six things went wrong there, one after another, the kind of problems you have probably met already if your team builds with AI.

It started on a Saturday, at twelve minutes past three in the morning, when the phone of Tomasz, an engineer on Larkfield's platform team, lit up the dark bedroom because the support assistant had stopped answering customers. Tomasz: "Two hundred customers waiting. I'm getting up."

He found the cause within minutes: OpenAI, the company that runs the assistant's model, was down, and although Anthropic was working fine, OpenAI's name was written into the app's code, so at three forty he was still rewriting it by hand. Tomasz: "I've done good work at three a.m. This isn't it."

That night had been building for a long time, because every app at Larkfield talked to its own provider, whether OpenAI, Anthropic or Google, and kept its own key, the secret that proves who is paying.

On Tuesday, Ollie, one of the developers, was so proud of an answer from the assistant that he shared a screenshot in the team chat, without noticing the team's OpenAI key in the corner of the picture. Maren: "Ollie. Bottom corner. That's our OpenAI key." Ollie: "Deleting it now. Eleven people have already seen it, though."

Then on Friday evening his research script hit an error and kept trying again, all weekend long, until by Monday morning it had spent the whole month's budget. Ollie: "In my defence, the error did say try again."

That Sunday, while the team was still cleaning up, Google renamed one of its models, and the three apps that had the old name typed into their code all stopped working at once. Tomasz: "They renamed it. On a Sunday."

When the invoice arrived at the end of the month, it showed a single number, and Graham, the head of engineering, asked the one question nobody in the room could answer. Graham: "Which team spent this? And with whom?"

And the month ended on a missed chance, because a new model came out, faster and cheaper, and Jess, the product manager, wanted to try it at once, even though that meant changing every app by hand. Jess: "It's faster AND cheaper! Can we try it today?" Tomasz: "Sure. In every app. By hand."

So here are the six problems from that month, and as each one appears, ask yourself whether it is normal, or a sign that something is missing.
