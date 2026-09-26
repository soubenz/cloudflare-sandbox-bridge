<!--
Persisted 26 Sep 2026 from the document the user pasted into the build
session, verbatim below the line. Kept in the repo because the original
30-lab catalogue was pasted into a chat once and never saved anywhere; this
one must not go the same way.

Decision recorded 25 Sep 2026 (user): phase 1 for this path is 21 labs, as
defined in the prose of section 3 -- "module 1 complete, the opening labs of
modules 2, 3 and 4, and one lab each from modules 6 and 7". Still open:
which exact labs in modules 2-4, 6 and 7 that means. The module tables below
still show five unmarked labs in every module, and five each for modules
1-4 plus one each for 6 and 7 is 22, not 21. The document also contains an
earlier "Phase 1 | 35" table; both totals are left exactly as written.

Build order agreed 25 Sep 2026: module 1 first, in table order.

Phase-1 count resolved 26 Sep 2026 (user): go with 21. The tables give 22
(five unmarked labs each in modules 1-4, one each in 6 and 7) unless one is
cut. Cut: Module 4's "Give every team its own view without its own stack"
(Langfuse) -- it was already flagged in this repo's build plan as
conflicting with the house no-login rule (Langfuse ships real accounts,
orgs and projects with a login page by default, no documented anonymous
mode), so it is the one phase-1 lab most likely to need rework or a
substitute tool regardless. Deferred to phase 2. Module 4's phase-1 set is
therefore its other four: the trace explore lab, propagation, telemetry
pipelines, and LiteLLM spend attribution with Grafana. Modules 1-3 keep
all five each (5+5+5+4+1+1 = 21).

ContextForge feasibility confirmed 26 Sep 2026 (investigation, before
Module 2 build started): real project (IBM's mcp-context-forge,
Apache-2.0), feasible for Module 2's five phase-1 labs with two changes.
It needs Python 3.12 in the image, not the default 3.10 -- pin
mcp-contextforge-gateway==1.0.10. And "Version tool definitions and roll
changes out safely" (lab 5) is redesigned: ContextForge has no real
canary/rollout/history mechanism (a bare edit counter plus enable/disable
plus whole-config export/import only), so the lab now asks the learner to
build their own staged-rollout/rollback discipline on those primitives,
not use a gateway feature that doesn't exist.

CORRECTED 26 Sep 2026 (found while building the first Module 2 lab):
AUTH_REQUIRED=false + ALLOW_UNAUTHENTICATED_ADMIN=true does not make
ContextForge's admin UI a safe `ui: true` tab -- a request shaped like a
browser (which the session console's iframe is) is redirected to a real
login form before that bypass is ever reached, traced to
mcpgateway/middleware/rbac.py and reproduced live. ContextForge is
`ui: false` in every lab, same as LiteLLM, with its own small stdlib view
page as the tab instead. The bypass is still real and useful for
non-browser callers (scripts, a view page's own server-side calls).

Built and verified live (26 Sep 2026). Each passes `labs test`: the
untouched workspace fails and solution/ passes. Each also fails every
planted wrong answer, on the intended check, against a live session.
- labs/see-what-a-gateway-does (explore): 2 wrong answers.
- labs/one-endpoint-one-key: 3 wrong answers.
- labs/hard-budget-per-team: 3 wrong answers. LiteLLM's
  fail_closed_budget_enforcement setting alone also passes; it is a
  legitimate fix.
- labs/keep-answering-when-a-provider-fails: 4 wrong answers.
Not built yet: "Add a model to the catalogue without touching app code"
(needs MLflow in the gateway image; feasible, awaiting the user's go-ahead).
-->

# Opalix Path 2: Building an AI Platform

Working document. Last updated: 22 September 2026.
Scope based on 2026 job posts, internal platform case studies and platform engineering reports. Sources are named per module, with an honest note on quality.

---

## 0. How to use this list

**Build only the unmarked labs.** Anything marked <sub>P2</sub> is backlog. It stays written down so the shape of each module is clear, and so nothing gets lost, but it is not work for now.

Rules for anyone, or anything, building from this file:

- Build the five unmarked labs in each module, nothing else.
- Do not write briefs, images, checkers or public pages for P2 labs.
- Do not count P2 labs in any estimate, plan or roadmap date.
- P2 labs get promoted only when real users ask for them, or when usage data shows a gap. Move the lab out of P2 in this file at that moment, and say why.

## 1. What a platform team owns in 2026

The clearest single description comes from a live job post. Kuok Group's AI Platform Engineer role is written as owning "the infrastructure layer that every AI use case runs on: the LLM gateway, the deployment platform, CI/CD pipelines, model serving, observability, cost controls, and the eval pipeline infrastructure, end to end", and asks for someone who has "configured and operated a model gateway or API proxy layer, managed multi-model routing, and dealt with rate limits and failover in a live environment", plus tracing and "cost telemetry and token controls".

Other evidence points the same way:

- A GSPANN AI Platform Engineer post lists LiteLLM, MCP server development, LangGraph, vector databases, Backstage, Prometheus, Grafana and OpenTelemetry, with "LLM routing, cost optimization and observability" named directly.
- An analysis of 2026 job specs reports that governance appears as a named responsibility in the majority of postings, and that routing across multiple providers is now a core duty rather than an optimisation.
- A 2026 career guide describes the role as "model gateways, evaluation infrastructure, RAG pipelines, agent runtimes, prompt versioning, and cost and latency observability across model providers", and notes the platform team usually picks the default RAG stack so application teams get a working pipeline out of the box.
- LiteLLM's own multi-tenancy documentation frames the problem as organisations, teams, users and keys, so that "cost has to be attributed to the right business unit rather than pooled" and admin can be delegated without platform-wide rights.
- A 2026 gateway reference calls the gateway "critical AI infrastructure rather than an optional add-on" and notes EU specifics: high-risk obligations under the EU AI Act becoming enforceable from 2 August 2026, and routing GDPR-covered data through US gateway infrastructure requiring completed standard contractual clauses.
- Case studies describe the same shape in practice. Wealthsimple built and open-sourced its own LLM gateway and added a self-service application platform so data scientists could ship experiments quickly. Whatnot built an internal LLM platform that let non-technical teams iterate on prompts.

**Honest note on sources.** Several of the strongest-sounding articles come from gateway vendors (Maxim, API7) and repeat Gartner numbers second-hand, for example that 40 percent of enterprise applications will embed agents by the end of 2026 and that 40 percent of enterprises will demote or decommission agents by 2027 over governance gaps. Treat those as direction, not fact. The job posts and the tool documentation are the firmer evidence.

**One recurring failure worth teaching.** Platform postmortems describe the same trap: a technically strong platform that nobody adopts, with teams going around it. One write-up reports under 15 percent voluntary adoption and "shadow AWS accounts proliferating faster than before" after a $400k build. Another describes the AI-specific version: the central team becomes a gate, queues grow, and product teams fall back to hardcoded API keys and personal vendor accounts. Golden paths, not governance documents, are what actually get followed.

---

## 2. The seven modules

| # | Module | Outcome the platform must deliver | Evidence strength | Stack |
|---|---|---|---|---|
| 1 | Gateway and access | One governed way to call any model, with identity, budgets and failover | Very strong | LiteLLM, Postgres |
| 2 | Tools and MCP | One governed way to reach any tool, with versioned definitions | Strong and growing | ContextForge |
| 3 | Retrieval as a service | A shared retrieval stack that teams can use without inventing one | Strong | pgvector, Qdrant, Milvus |
| 4 | Observability and cost | Answer what happened, what it cost and who spent it | Very strong | OTel Collector, Grafana, Langfuse, Phoenix, MLflow |
| 5 | Runtime and durability **(optional)** | Work that survives restarts, and models served within budget | Strong | Ollama, LangGraph, Temporal |
| 6 | Self-service and golden paths | A new team ships safely on day one without a ticket | Strong for platforms generally, thinner for AI specifically | Templates, LiteLLM, ContextForge |
| 7 | Compliance and sovereignty | Prove where data went, keep it in the right place, keep the audit trail | Strong in the EU, growing elsewhere | LiteLLM routing, Langfuse, Presidio |
| 8 | Capstone | A platform three teams actually share | | All of it |

---

## 3. Candidate labs

Titles are outcome-style. The stack line says what it runs on. Types: Build, Harden, Tune, Investigate, Break-fix, Capstone.

Each module is a set of build labs, one tune lab where it fits, and it ends with a **module exam**: a fix lab set in the platform the learner just built.

**Phase marking.** Labs marked are phase 2. They stay in the plan, but they are written after launch. Everything unmarked is phase 1: the 21 labs that make the path usable on day one. Phase 1 is module 1 complete, the opening labs of modules 2, 3 and 4, and one lab each from modules 6 and 7 so all six required modules show real content.


**How the exams work**

- The exam breaks the platform from that module, usually in two places at once.
- No hints by default. A hint can be taken, and it shows on the result.
- The tutor answers questions about what things mean, never what is wrong.
- Passing the exam completes the module. Retakes are unlimited, with a different fault each time.
- Exams run 60 to 90 minutes, longer than a build lab, so by time they are close to 30 percent of the path.

**One more lab type: explore.** A module can open with a short guided tour of the system it is about. Nothing is broken and nothing is missing. The learner runs the thing, pokes at it, and answers a few questions about what they saw. It takes 20 to 30 minutes, it lowers the wall before the first build lab, and it doubles as a free public lab.


### Module 1: Gateway and access (10 labs)

| Lab | Type | Stack | What makes it hard |
|---|---|---|---|
| See what a gateway actually does | Explore | LiteLLM, Postgres | Nothing yet. Send calls, watch routing, read the spend log, change config and see it reload |
| Give every team one endpoint and one key | Build | LiteLLM, Postgres | Model aliases, key scopes and delegated admin without platform-wide rights |
| Put a hard budget on every team | Build | LiteLLM, Postgres | Stopping before the limit, not after, and failing with a clear error |
| Add a model to the catalogue without touching app code | Build | LiteLLM, MLflow | Aliases, pinning, per-team allowlists and a staged switch |
| Keep answering when a provider fails | Build | LiteLLM, fault proxy | Retries, fallback and cooldown are three different controls |
| Keep the platform fair when a provider throttles <sub>P2</sub> | Build | LiteLLM, load generator | Bounded queues, deadlines and priority instead of blind retries |
| Put a cache in front of the providers <sub>P2</sub> | Build | LiteLLM, Redis | Cache keys with tenant and version boundaries, and invalidation that works |
| Record every call for spend and audit <sub>P2</sub> | Build | LiteLLM, Postgres, object storage | Metadata that survives retries, exports finance can reconcile |
| Cut spend 40 percent without losing quality <sub>P2</sub> | Tune | LiteLLM, Redis | Routing and caching measured against a quality bar |
| **Exam: the gateway falls over on launch day** <sub>P2</sub> | Fix | LiteLLM, load generator, fault proxy | Failover that never cools down the primary, plus one team's batch job starving chat |

### Module 2: Tools and MCP (10 labs)

| Lab | Type | Stack | What makes it hard |
|---|---|---|---|
| See how tools reach an agent | Explore | ContextForge | Run the gateway, list tools, call one, watch the request in the logs |
| Put every tool server behind one endpoint | Build | ContextForge | Virtual servers, tool filtering, per-client auth |
| Give each agent only the tools it needs | Build | ContextForge, LiteLLM keys | Scope by role, enforced at the gateway and not in prompts |
| Write a tool server the platform can host | Build | MCP SDK | Typed inputs, real errors, pagination, and a health check |
| Version tool definitions and roll changes out safely | Build | ContextForge | Pinning, staged rollout, rollback in under a minute |
| Let a team register its own tool server safely <sub>P2</sub> | Build | ContextForge registry | Self-service with review, health checks and limits |
| Put limits on what tools can do <sub>P2</sub> | Build | ContextForge | Timeouts, size caps, concurrency and rate limits per agent |
| Trace every tool call end to end <sub>P2</sub> | Build | ContextForge, OTel | Linking a tool call to the model call that asked for it |
| Cut tool latency in half <sub>P2</sub> | Tune | ContextForge, Redis | Parallel calls, result caching and connection reuse, without stale data |
| **Exam: the partner tool server goes rogue** <sub>P2</sub> | Fix | ContextForge, poisoned server | Definitions change after approval, and one description hides instructions |

### Module 3: Retrieval as a service (10 labs)

| Lab | Type | Stack | What makes it hard |
|---|---|---|---|
| See why a document matched | Explore | pgvector, Phoenix | Run queries, read scores, look at what was retrieved and why |
| Offer teams a retrieval service they do not have to build | Build | pgvector, FastAPI | An API with tenants, filters and a recall test |
| Build the ingestion pipeline behind it | Build | pgvector or Qdrant | Chunking, embedding, updates, deletes and duplicates, all repeatable |
| Add hybrid search and reranking | Build | pgvector or Qdrant | Combining keyword and vector without making both worse |
| Keep the index fresh without downtime | Build | Qdrant | Incremental updates and reindex while queries keep running |
| Keep one tenant's documents away from another <sub>P2</sub> | Build | Qdrant or pgvector | Filtering during search, plus permissions checked at query time |
| Measure retrieval quality continuously <sub>P2</sub> | Build | Phoenix, golden set | A recall harness that runs on every change, not once |
| Choose the right store with a benchmark, not an opinion <sub>P2</sub> | Build | pgvector, Qdrant, Milvus | Same workload, same questions, measured recall, latency and memory |
| Hit recall 0.95 at p95 under 50 ms <sub>P2</sub> | Tune | pgvector or Qdrant | Recall and latency pull in opposite directions |
| **Exam: search is wrong, and nobody knows since when** <sub>P2</sub> | Fix | Qdrant, ingestion job | Ingestion failing quietly, and filters dropping results for small tenants |

### Module 4: Observability and cost (10 labs)

| Lab | Type | Stack | What makes it hard |
|---|---|---|---|
| Follow one request through the stack | Explore | Jaeger or Tempo | Read an existing trace and find where the time and the tokens went |
| See one request across every service | Build | OTel SDK and Collector | Context propagation through the gateway and a queue |
| Collect telemetry without losing the errors | Build | OTel Collector | Pipelines, batching and sampling that always keeps failures |
| Tell finance who spent the money | Build | LiteLLM spend logs, Grafana | Attribution per team, feature and request, matching the bill |
| Give every team its own view without its own stack | Build | Langfuse | Projects, sessions, users, scores and access per team |
| Build the alerts that catch a silent failure <sub>P2</sub> | Build | Grafana, Prometheus | Alerting on quality and cost, not only errors, without noise |
| Publish platform SLOs and prove them <sub>P2</sub> | Build | Grafana, synthetic checks | Choosing indicators for a non-deterministic system |
| Keep an audit record of every model call <sub>P2</sub> | Build | Langfuse or OTel, object storage | Retention, redaction and proving nothing is missing |
| Cut telemetry cost by half without losing the signal <sub>P2</sub> | Tune | OTel Collector | Sampling, attribute trimming and retention, with errors untouched |
| **Exam: the bill tripled and the dashboard says fine** <sub>P2</sub> | Fix | OTel, Grafana, spend logs | Renamed attributes hide the spend, and the cause must be named with numbers |

### Module 5: Runtime and durability (optional)

This module is marked optional. A platform team can run a useful platform without owning the runtime, since many teams bring their own framework and their own serving. Learners who need it are the ones running local models or long-running agent work. Path completion does not require it, and the capstone does not depend on it.

| Lab | Type | Stack | What makes it hard |
|---|---|---|---|
| See what happens when a run is interrupted | Explore | LangGraph | Kill a run, restart it, watch what was kept and what was lost |
| Serve a local model for the team that cannot send data out | Build | Ollama | Context length, memory and concurrency on CPU |
| Put the local model behind the gateway | Build | Ollama, LiteLLM | Failover in both directions, and one interface for callers |
| Run agent work that survives a restart | Build | LangGraph, Postgres | Checkpoints, thread identity and resume |
| Make long-running work durable | Build | Temporal | Retries, timeouts and heartbeats owned by the runtime |
| Add human approval inside a running workflow <sub>P2</sub> | Build | Temporal | Signals, waiting for days, and timeouts that do the right thing |
| Build the batch lane for overnight work <sub>P2</sub> | Build | Temporal or Celery | Queues, concurrency caps and deadlines that do not starve live traffic |
| Deploy without losing work <sub>P2</sub> | Build | Temporal, LangGraph | Draining, graceful shutdown and versioning |
| Serve 16 users at once on 4 vCPU <sub>P2</sub> | Tune | Ollama | Concurrency and context compete for the same memory |
| **Exam: Friday deploy, Monday backlog** <sub>P2</sub> | Fix | Temporal, LangGraph | Stuck workflows that cannot be restarted, and a batch lane eating live capacity |

### Module 6: Self-service and golden paths (10 labs)

| Lab | Type | Stack | What makes it hard |
|---|---|---|---|
| Onboard yourself the way a new team sees it | Explore | Platform docs, gateway | Follow the current path and note every step that costs time |
| Onboard a new team in under an hour | Build | LiteLLM, ContextForge, templates | One command that issues keys, budgets, tools and a working example |
| Publish a paved road for a new AI feature | Build | Template repo, gateway, tracing | Defaults that make the safe path the fast path |
| Keep the docs and the example true | Build | Template repo, CI checks | Tested documentation, so the golden path never rots |
| Build the page where teams request access | Build | Simple portal, gateway API | Requests, approvals and provisioning without a ticket queue |
| Give teams a local setup that matches production <sub>P2</sub> | Build | Fake provider, seeded data | Same interface, no real spend, no surprises at deploy |
| Measure whether teams actually use the platform <sub>P2</sub> | Build | Gateway logs, Grafana | Adoption, time to first call, and where people fall off |
| Retire something without breaking anyone <sub>P2</sub> | Build | Gateway, template repo | A deprecation policy, a migration path and a deadline that holds |
| Cut time to first call from three days to one hour <sub>P2</sub> | Tune | Onboarding flow | Removing steps and approvals without losing control |
| **Exam: the team went around you** <sub>P2</sub> | Fix | Gateway, template repo, CI checks | A rotted golden path, and traffic running outside the platform |

### Module 7: Compliance and sovereignty (10 labs)

| Lab | Type | Stack | What makes it hard |
|---|---|---|---|
| Prove where one request's data went | Explore | Traces, gateway logs | Follow a single request across providers, regions and logs |
| Keep EU data on EU routes | Build | LiteLLM routing rules | Routing by data class, with a provable trail |
| Strip personal data before it reaches a model or a log | Build | Presidio, gateway hook | Recall and false positives, in two languages |
| Control what can leave the platform | Build | Gateway, egress allowlist | Providers and tools that may be reached, and nothing else |
| Set retention and deletion that actually run | Build | Langfuse or OTel, object storage | Deleting one customer's data from traces, caches and exports |
| Keep an approvals record for model and prompt changes <sub>P2</sub> | Build | MLflow, promptfoo | Evidence a reviewer accepts, produced automatically |
| Build the inventory of AI systems in use <sub>P2</sub> | Build | Gateway metadata, MLflow | Purpose, owner, data class and risk level, kept current by the platform |
| Produce the audit pack for one customer <sub>P2</sub> | Build | Langfuse or OTel, object storage | Completeness, retention limits and redaction together |
| Keep redaction under 50 ms at 95 percent recall <sub>P2</sub> | Tune | Presidio | Accuracy, speed and languages pulling against each other |
| **Exam: the audit request arrives on Thursday** <sub>P2</sub> | Fix | Presidio, Langfuse, routing rules | Personal data in old traces, and one route that left the region |

### Capstone

**A platform three teams share.** A batch team, a latency-sensitive chat team and a team handling sensitive data all onboard on the same day. Budgets, priorities, routing rules and data rules are configured, then a simulated day runs with a provider outage, a noisy neighbour and an audit request. Every team's targets must hold at once.

**Totals:** 70 labs plus the capstone. Every module is 1 Explore, 7 Build, 1 Tune and 1 Exam.

| | Labs | What it covers |
|---|---|---|
| Phase 1 | 35 | The first 5 labs of every module: explore plus four builds |
| Phase 2 | 35 | Remaining builds, the tune lab and the exam in each module |
| Optional | Module 5, 10 labs | Runtime and durability, phase 1 and 2 like the rest |

**One consequence to accept.** The labs shipping now contain no exams, since each exam sits at the end of its module. Nobody completes a module yet. Either present modules as in progress and let learners finish labs, or promote module 1's exam out of backlog so one module can be completed and one result can be shared. I would promote module 1's exam.

**Build time.** At one lab a week alongside consulting, 35 labs is roughly eight months for this path. If that is too long before launch, cut phase 1 to the required modules only, which drops module 5 and brings it to 30 labs.

---|---|---|
| Phase 1 | 21 | Module 1 complete, openings of modules 2, 3 and 4, one lab each in 6 and 7 |
| Phase 2 | 49 | The rest, written after the launch numbers come back |
| Optional | Module 5, 10 labs | Runtime and durability, all phase 2 |

**Phase 1 at one lab a week is about five months.** It gives a complete first module, so a learner can finish something, and visible content in every required module, so the path does not look empty.

**The ratio note still stands.** With one exam per module, fix is 10 percent by count across the full path. If you want closer to 30 percent, add a mid-module exam after the first four labs of each module, which gives 14 exams, about 20 percent by count and close to 30 percent by time.

---

## 4. What does not belong in Path 2

| Topic | Why not |
|---|---|
| Agent-level failures: retries, idempotency, context trimming, handoff | Path 1 |
| Eval design, judges, release gates, canary | Path 3 |
| Injection depth, red-teaming, supply chain attacks | Path 4 |
| GPU scheduling, MIG, real serving performance | No GPU in the sandbox |
| Kubernetes operators, cluster autoscaling, service mesh | No Kubernetes in the sandbox |
| Fine-tuning and training pipelines | Different audience, and too heavy for a session |

The security and eval modules here stay at platform level: enforce at the gateway, keep the audit trail, provide the eval infrastructure as a service. The deep versions live in their own paths.

---

## 5. First five labs to build

1. **Give every team one endpoint and one key.** The gateway is the most named responsibility in job posts, and every other module depends on it existing.
2. **Tell finance who spent the money.** Cost attribution appears in almost every job post and is the first thing a manager asks a platform team.
3. **See one request across every service.** Tracing is the base layer for the whole observability module.
4. **Offer teams a retrieval service they do not have to build.** The platform team picks the default RAG stack, so this is the work as it really happens.
5. **Put every tool server behind one endpoint.** MCP governance is the newest topic with the least existing training content.

---

## 6. Open points

- Trim 34 candidates to about 25, since some overlap (three tenant-isolation labs could be two)
- Decide whether the sovereignty module is a full module or three labs inside others, given it is EU-weighted
- Confirm container feasibility for Langfuse, Milvus and ContextForge before the modules that depend on them
- Check search demand per lab title before writing the public pages
