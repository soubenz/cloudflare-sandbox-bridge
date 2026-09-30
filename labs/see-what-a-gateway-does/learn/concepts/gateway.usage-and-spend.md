---
id: gateway.usage-and-spend
title: Tokens, cost and the spend log
minutes: 3
recap: Every response carries prompt and completion token counts; the gateway records them per call, and spend is tokens times a per-model price.
---
A model call is billed by size, not by count. The unit is the token: the input you send (prompt tokens) and the output you get back (completion tokens). Every chat response carries a `usage` block with both, plus a total that is simply their sum.

::diagram[gateway-usage-and-spend]

The provider is the one that counts. The gateway reads the `usage` block out of the provider's response and writes it down. That is why a gateway is a good place for cost data: every call passes through it, and it stores what it saw.

The record is the spend log, one row per call. In this lab it sits in Postgres, and LiteLLM serves it at `/spend/logs`. Each row holds the timestamp, the alias, the prompt, completion and total token counts, and a `spend` figure.

Spend is derived, not measured. The gateway multiplies the token counts by a per-token price it holds for that model. If it has no price for a model, spend cannot be a useful number even though the tokens are still exact. So when you read a spend column, ask two questions: are the token counts right, and does the gateway know a price? The tokens are the durable fact. Money is tokens times a price table someone has to keep current.

This is also how Jonas's question, "who spent this?", becomes answerable. The row is written per call and carries the alias, so a real deployment adds a team or key on the same row and totals become a query. This lab stops at the alias.

Now look at how the two sides of one call fit together. The provider keeps its own log of what it was asked and what it returned. The gateway keeps its own record of the same call. They are independent witnesses. If the two disagree about token counts, one of them is wrong and that is a finding, not noise.

In the lab, send a call, then open the **view** tab. The bottom table is the gateway's spend log and the top one is the provider's log. Compare the token columns row by row. The message you send changes only the prompt side, so change it and see which columns move.
