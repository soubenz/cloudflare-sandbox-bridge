---
title: Four teams, four keys
minutes: 2
---
It is your second Monday at Larkfield, and Maren Osei starts the day with what she calls the museum tour.

Exhibit one: four product teams, four model providers, four API keys, each pasted into its own repo. One key also lives in a screenshot in a team chat. The screenshot got a lot of thumbs-up. Nobody noticed the key.

Exhibit two: a Saturday, three in the morning. One provider goes down. Priya Nair's Support assistant stops answering customers. Search's assistant, on another provider, carries on happily, and nobody can point Support at it, because the provider's name is written into Support's code.

Exhibit three: a provider renames one model. Three apps had the old name written in their code. All three broke before breakfast.

Exhibit four: Jonas Berg in Finance gets one invoice a month. Which team spent it? Which provider answered which reply? He gets a shrug.

Exhibit five: a research script retries a failing call, forever, from Friday evening. By Monday the month's budget is gone and the script is still asking politely.

"Tomasz saw this coming," Maren says. "Before he moved on he built a prototype gateway." It is one front door for every model call. A team asks for a stable name such as `support` and never mentions a provider. The gateway holds the keys, picks the provider, writes down every call with its tokens and cost, and is meant to switch to another provider when one fails.

"Meant to," Maren repeats. "Before three more teams move in, I want someone who has never seen it to tell me what it really does."

She has set you up with a small copy: the gateway, a database behind it, and a scripted stand-in for a provider that keeps its own record of every call. No real model, no real bill. The copy has no fallback and one master key, so you will test what it does have: where a call is routed, what gets recorded about it, and how it complains when it cannot serve one.

Three questions are waiting in the lab. Start by sending it a call.
