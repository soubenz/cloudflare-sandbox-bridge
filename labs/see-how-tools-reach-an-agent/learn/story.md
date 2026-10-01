---
title: One door for the tools
minutes: 2
---
Thursday morning, a note arrived from Priya in Support. A customer had asked why their parcel was late, and her assistant answered with a very confident little poem about rain. A poem. In a delivery update.

To answer properly, her assistant needs the real weather in the depot's city. Search wrote a weather lookup last quarter, and Billing wrote its own calculator. The trouble is that each one is wired into its own agent in its own way. That is two kinds of glue already, and Priya's team was about to invent a third.

Then security came to me with one request: agents should reach tools through one door, and that door should know exactly what was called. Fair enough. Today nobody could tell them.

So we have set up a tool gateway. Tool servers sign up with it, it gathers the tools we choose into one place, and an agent connects to that one place. The agent asks what is on offer, then calls a tool by name. Tomasz has put two toy servers behind it, a weather one and a calculator. Nothing real is connected, so nothing you try can reach a customer. He asks you to be nice to them anyway.

Here is the part I care about most. Priya's assistant will read whatever comes back, so the shape of a failure matters as much as the shape of a success, and the status code alone will not tell you which one you got. Read the bodies. People skip them and regret it.

Before Priya's team writes any code against it, I want you to see it from the agent's side: which tools it is offered, a small sum, and a call to something that does not exist. Then come and tell me what you saw.
