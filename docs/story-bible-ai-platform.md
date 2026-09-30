# Story bible: the AI platform path

Every lab in "Building an AI Platform" is a chapter of one story. This file is the source of truth for names, facts and voice. A story that contradicts it is a bug.

## The company

**Larkfield** is a mid-sized European logistics software company: about 900 people, 40 product teams, warehouses and last-mile delivery for retailers. Four teams started building with language models on their own last year. Each picked a different provider, kept keys in its own repo, and none of them can say what it spends.

Three months ago leadership funded a small **platform team** to give every product team one way to use models, tools and retrieval, with cost and data controls built in.

## The learner

You are a **new platform engineer**, in your first weeks. You are experienced in general software engineering but new to this stack. You are not a beginner and are never talked down to. You do not know Larkfield's history, so the story explains it as you meet it.

## The cast

| Person | Role | How they sound |
|---|---|---|
| **Maren Osei** | Platform lead, your manager | Direct, dry, gives you the task and the deadline, never the solution. Explains why it matters. |
| **Tomasz Wieland** | Staff engineer, built the first gateway prototype | Precise. Apologises for his own shortcuts in comments. Knows where the bodies are buried. |
| **Priya Nair** | Head of the Support product team, your most demanding customer | Practical, impatient, cares about the customer-facing result, not the plumbing. |
| **Jonas Berg** | Finance partner | Wants a number he can put in a report. Asks "who spent this?" |
| **Dr. Anneke de Vries** | Data protection officer | Calm, exact, asks where data went and can you prove it. |

Keep the cast small. A lab uses one or two of them, never all five.

## Places and systems

- The **gateway** is `gateway.larkfield.internal`. Teams call model aliases such as `support` and `fast`, never provider model names.
- The **tool hub** is one endpoint that fronts the tool servers agents may call.
- The **knowledge service** answers retrieval questions over Larkfield's documents.
- Traces flow to the **observability stack**. The spend log is the record finance reads.
- Product teams: **Support**, **Search**, **Billing**, **Research**.
- Regions: **EU** (default) and **US** (allowed for some routes only). Data protection rules decide which.

## Voice rules

1. Second person, plain sentences, no marketing words.
2. Open on a concrete moment ("It is Monday, ten past nine") not a summary of the topic.
3. Stakes are ordinary and real: a wrong invoice, an angry customer, a report due Friday. No disasters, no villains.
4. The story hands over the task and stops. It never states the fix, names the setting to change or the command to run.
5. Numbers are deterministic and match the lab's own data. Never invent a figure the lab cannot show.
6. Two minutes to read at most: under 350 words.
7. No humour at the learner's expense. Mild humour in the cast is fine.

## Story spine per module

| Module | The moment |
|---|---|
| 1 Gateway | Support's bill is a surprise and nobody knows which provider answered which call. |
| 2 Tools | Agents need tools, and every team wired its own. Security wants one door. |
| 3 Retrieval | Support agents give answers that sound right and cite the wrong document. |
| 4 Tracing and cost | A slow, expensive request nobody can explain. Finance wants a breakdown by team. |
| 6 Self-service | A new team wants to start on Monday and the checklist is a wiki page. |
| 7 Sovereignty | An auditor asks where one customer's data went. |

## Continuity

- A lab's story may refer to an earlier chapter but must make sense on its own.
- Facts fixed here (names, product teams, regions) do not change between labs.
- New facts a lab introduces stay local to that lab unless added to this file.
