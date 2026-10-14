---
title: Six things went wrong
minutes: 2
---
This is Larkfield, a company whose apps all use AI models. Last month, six things went wrong there. If your team builds with AI, you have probably seen some of them already.

It starts on a Saturday. At three twelve in the morning, the phone of Tomasz, an engineer on Larkfield's platform team, lights up the dark bedroom. The support assistant has stopped answering customers. Tomasz: "Two hundred customers waiting. I'm getting up."

He finds the cause fast. OpenAI, the company that runs the assistant's model, is down. Anthropic is up, but OpenAI's name is written into the app's code. So at three forty, Tomasz is still rewriting it by hand. Tomasz: "I've done good work at three a.m. This isn't it."

That night did not come out of nowhere. Every app at Larkfield talks to its own provider, OpenAI, Anthropic or Google, and holds its own key. A key is the secret that proves who is paying.

On Tuesday, Ollie, a developer, is proud of an answer from the assistant and shares a screenshot in the team chat. In the corner of the picture sits the team's OpenAI key. Maren, who leads the platform team: "Ollie. Bottom corner. That's our OpenAI key." Ollie: "Deleting it now. Eleven people have already seen it, though."

Then, on Friday evening, Ollie's research script hits an error and simply tries again. It keeps trying all weekend. By Monday morning it has spent the whole month's budget. Ollie: "In my defence, the error did say try again."

That Sunday, while the team is still cleaning up, Google renames one of its models. Three apps have the old name typed into their code, and all three stop working at once. Tomasz: "They renamed it. On a Sunday."

At the end of the month, one invoice arrives with one number on it. Graham, the head of engineering, has a simple question for the team, and nobody can answer it. Graham: "Which team spent this? And with whom?"

The month ends on a missed chance. A new model comes out, faster and cheaper. Jess, the product manager, wants to try it today, but trying it means changing every app by hand. Jess: "It's faster AND cheaper! Can we try it today?" Tomasz: "Sure. In every app. By hand."

One month, six problems. Read each one, and ask yourself whether it is normal, or a sign that something is missing.

- OpenAI goes down, and the fix is rewriting app code at 3 a.m.
- An OpenAI key leaks in a screenshot in the team chat.
- A script retries all weekend and spends the month's budget.
- Google renames a model, and three apps break at once.
- One invoice, and nobody can say which team spent what.
- A faster, cheaper model nobody can try without changing every app.
