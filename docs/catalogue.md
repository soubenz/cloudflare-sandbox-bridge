# Opalix lab catalogue

This is the canonical list of labs: one table per learning path, with the code, placement, tier and expected time of every lab. The manifest fields `path`, `module`, `order`, `tier` and `estimated_minutes` in `labs/*/manifest.yaml` must match it, and the published lab index is sorted by `(path, module, order, slug)`.

**Path numbering.** Path 1 is Production Agents Essentials, Path 2 is Securing AI Agents, Path 3 is Building an AI Platform and Path 4 is Evals and Safe Releases (numbering from the product plan, section 21). Path 3's detailed source is `docs/catalogue-path-2-ai-platform.md`. That file name says "path-2" for historical reasons: it was written before the paths were renumbered, and its "Path 2" is this catalogue's Path 3. Its module numbers and row order are the `module` and `order` values used here.

**Prerequisite rule.** A module's explore lab (order 1, `type: explore`) is the prerequisite of that module's order-2 lab and of nothing else. Modules without an explore lab have no prerequisites.

**Reading the tables.** `status` is `built` for a lab in `labs/` and `planned` for one that is designed but not written; planned rows have no slug and no order until they are built. The `code` for Path 3 is `M<module>-<order>`; the two labs whose manifests carry an older P3 code show it in brackets. Order numbers need not be contiguous (`code-tool-secrets` is order 5 with 1 to 4 still planned). Path 3 Module 5, Runtime and durability, is optional. Estimates are the midpoint of the solve range in the plan's lab review (section 33.5), rounded to 5 minutes.

## Path 1: Production Agents Essentials

`path: production-agents`

| code | slug | title | family | type | module | order | tier | est. min | status |
|---|---|---|---|---|---|---|---|---|---|
| P1-01 | `duplicate-emails` | Customers are getting the same reply twice | agent | break-fix | 1 | 1 | free | 35 | built |
| P1-02 | `weekend-bill` | The $4,000 weekend | agent | break-fix | 1 | 2 | free | 45 | built |
| P1-03 | `phantom-stockouts` | We are telling customers we are sold out when we are not | agent | break-fix | 1 | 3 | pro | 40 | built |
| P1-04 | `down-with-the-provider` | The provider is down, and so are we | agent | break-fix | 1 | 4 | pro | 45 | built |
| P1-05 | `forgotten-rules` | The agent forgot its rules at message 40 | agent | break-fix | 1 | 5 | pro | 50 | built |
| P1-06 | `silent-wrong-answers` | It answers, but it is wrong | agent | break-fix | 1 | 6 | pro | 70 | built |
| P1-07 | — | Streaming: Streaming responses that break mid-way; structure-only grading, needs a fault worker | agent | build | 1 | — | — | — | planned |
| P1-08 | — | Tool-call loop: An agent that keeps calling the same tool; scripted | agent | break-fix | 1 | — | — | — | planned |

## Path 2: Securing AI Agents

`path: securing-agents`

| code | slug | title | family | type | module | order | tier | est. min | status |
|---|---|---|---|---|---|---|---|---|---|
| P2-05 | `code-tool-secrets` | The code tool read the secrets file | agent | build | 1 | 5 | pro | 75 | built |
| P2-01 | — | Injected tool output: Instructions hidden in a tool result take over the agent | agent | break-fix | 1 | — | — | — | planned |
| P2-02 | — | Secrets in prompts and logs: Find and stop credentials leaking into prompts and logs | agent | break-fix | 1 | — | — | — | planned |
| P2-03 | — | Least-privilege tools: Scope each agent to the tools it needs; reuses the Path 3 Module 2 rig | agent | build | 1 | — | — | — | planned |
| P2-04 | — | Confirmation before side effects: Irreversible actions wait for an explicit confirmation | agent | build | 1 | — | — | — | planned |
| P2-06 | — | Egress: Limit what an agent can reach outside the platform | agent | build | 1 | — | — | — | planned |

## Path 3: Building an AI Platform

`path: ai-platform`

| code | slug | title | family | type | module | order | tier | est. min | status |
|---|---|---|---|---|---|---|---|---|---|
| M1-1 | `see-what-a-gateway-does` | See what a gateway actually does | gateway | explore | 1 | 1 | free | 15 | built |
| M1-2 | `one-endpoint-one-key` | Give every team one endpoint and one key | gateway | build | 1 | 2 | pro | 75 | built |
| M1-3 | `hard-budget-per-team` | Put a hard budget on every team | gateway | build | 1 | 3 | pro | 55 | built |
| M1-4 | `add-a-model-without-touching-app-code` | Add a model to the catalogue without touching app code | gateway | build | 1 | 4 | pro | 105 | built |
| M1-5 | `keep-answering-when-a-provider-fails` | Keep answering when a provider fails | gateway | build | 1 | 5 | pro | 40 | built |
| M1-6 (P3-01) | `locked-out-in-credit` | A tenant got locked out while still in credit | gateway | break-fix | 1 | 6 | pro | 20 | built |
| M2-1 | `see-how-tools-reach-an-agent` | See how tools reach an agent | agent | explore | 2 | 1 | pro | 20 | built |
| M2-2 | `one-endpoint-for-every-tool` | Put every tool server behind one endpoint | agent | build | 2 | 2 | pro | 55 | built |
| M2-3 | `give-each-agent-only-the-tools-it-needs` | Give each agent only the tools it needs | agent | build | 2 | 3 | pro | 55 | built |
| M2-4 | `write-a-tool-server-the-platform-can-host` | Write a tool server the platform can host | agent | build | 2 | 4 | pro | 50 | built |
| M2-5 | `version-tool-definitions-safely` | Version tool definitions and roll changes out safely | agent | build | 2 | 5 | pro | 60 | built |
| M3-1 | `see-why-a-document-matched` | See why a document matched | gateway | explore | 3 | 1 | pro | 15 | built |
| M3-2 | `offer-a-retrieval-service-teams-dont-build` | Offer teams a retrieval service they do not have to build | gateway | build | 3 | 2 | pro | 15 | built |
| M3-3 | `build-the-ingestion-pipeline` | Build the ingestion pipeline behind it | gateway | build | 3 | 3 | pro | 55 | built |
| M3-4 | `add-hybrid-search-and-reranking` | Add hybrid search and reranking | gateway | build | 3 | 4 | pro | 25 | built |
| M3-5 | `keep-the-index-fresh-without-downtime` | Keep the index fresh without downtime | gateway | build | 3 | 5 | pro | 35 | built |
| M4-1 | `follow-one-request-through-the-stack` | Follow one request through the stack | gateway | explore | 4 | 1 | free | 10 | built |
| M4-2 | `see-one-request-across-every-service` | See one request across every service | gateway | build | 4 | 2 | pro | 30 | built |
| M4-3 | `collect-telemetry-without-losing-the-errors` | Collect telemetry without losing the errors | gateway | build | 4 | 3 | pro | 25 | built |
| M4-4 | `tell-finance-who-spent-the-money` | Tell finance who spent the money | gateway | build | 4 | 4 | pro | 40 | built |
| M5-5 (P3-05) | `split-brain-chat` | Two replicas, two different conversations | agent | break-fix | 5 | 5 | pro | 60 | built |
| M6-1 | `onboard-yourself-the-way-a-new-team-sees-it` | Onboard yourself the way a new team sees it | gateway | explore | 6 | 1 | pro | 20 | built |
| M6-2 | `onboard-a-new-team-in-an-hour` | Onboard a new team in under an hour | gateway | build | 6 | 2 | pro | 25 | built |
| M6-3 | `publish-a-paved-road` | Publish a paved road for a new AI feature | gateway | build | 6 | 3 | pro | 15 | built |
| M6-4 | `keep-the-docs-and-the-example-true` | Keep the docs and the example true | gateway | build | 6 | 4 | pro | 50 | built |
| M6-5 | `build-the-access-request-portal` | Build the page where teams request access | gateway | build | 6 | 5 | pro | 55 | built |
| M7-1 | `prove-where-one-requests-data-went` | Prove where one request's data went | gateway | explore | 7 | 1 | pro | 20 | built |
| M7-2 | `keep-eu-data-on-eu-routes` | Keep EU data on EU routes | gateway | build | 7 | 2 | pro | 20 | built |
| M7-3 | `strip-personal-data-before-it-leaves` | Strip personal data before it reaches a model or a log | gateway | build | 7 | 3 | pro | 25 | built |
| M7-4 | `control-what-can-leave-the-platform` | Control what can leave the platform | gateway | build | 7 | 4 | pro | 30 | built |
| M7-5 | `set-retention-and-deletion-that-runs` | Set retention and deletion that actually run | gateway | build | 7 | 5 | pro | 15 | built |
| — | — | Exam: the gateway falls over on launch day: keep-answering-when-a-provider-fails rig plus hard-budget-per-team teams; two silent faults at t0. Build first | gateway | exam | 1 | — | — | — | planned |
| — | — | Exam: the bill tripled and the dashboard says fine: tell-finance-who-spent-the-money Grafana; a fault renames a tag mid-run. Build first | gateway | exam | 4 | — | — | — | planned |
| — | — | Measure retrieval quality continuously: offer-a-retrieval-service-teams-dont-build corpus plus a golden set; recall harness that runs on every change. Build first | gateway | build | 3 | — | — | — | planned |
| — | — | Keep the platform fair when a provider throttles: Bounded queues, deadlines and priority instead of blind retries | gateway | build | 1 | — | — | — | planned |
| — | — | Put a cache in front of the providers: Cache keys with tenant and version boundaries, and invalidation that works | gateway | build | 1 | — | — | — | planned |
| — | — | Record every call for spend and audit: Metadata that survives retries, exports finance can reconcile | gateway | build | 1 | — | — | — | planned |
| — | — | Cut spend 40 percent without losing quality: Routing and caching measured against a quality bar | gateway | tune | 1 | — | — | — | planned |
| — | — | Let a team register its own tool server safely: Self-service with review, health checks and limits | agent | build | 2 | — | — | — | planned |
| — | — | Put limits on what tools can do: Timeouts, size caps, concurrency and rate limits per agent | agent | build | 2 | — | — | — | planned |
| — | — | Trace every tool call end to end: Link a tool call to the model call that asked for it | agent | build | 2 | — | — | — | planned |
| — | — | Exam: the partner tool server goes rogue: Definitions change after approval, and one description hides instructions | agent | exam | 2 | — | — | — | planned |
| — | — | Keep one tenant's documents away from another: Filtering during search, plus permissions checked at query time | gateway | build | 3 | — | — | — | planned |
| — | — | Choose the right store with a benchmark, not an opinion: Same workload and questions across pgvector, Qdrant and Milvus | gateway | build | 3 | — | — | — | planned |
| — | — | Build the alerts that catch a silent failure: Alert on quality and cost, not only errors, without noise | gateway | build | 4 | — | — | — | planned |
| — | — | Publish platform SLOs and prove them: Choose indicators for a non-deterministic system | gateway | build | 4 | — | — | — | planned |
| — | — | Runtime and durability, all ten labs (optional module): See what happens when a run is interrupted; local model with Ollama and behind the gateway; LangGraph checkpoints; Temporal durability, approval, batch lane, deploys; tune; exam | gateway | mixed | 5 | — | — | — | planned |
| — | — | Give teams a local setup that matches production: Same interface, no real spend, no surprises at deploy | gateway | build | 6 | — | — | — | planned |
| — | — | Measure whether teams actually use the platform: Adoption, time to first call, and where people fall off | gateway | build | 6 | — | — | — | planned |
| — | — | Retire something without breaking anyone: A deprecation policy, a migration path and a deadline that holds | gateway | build | 6 | — | — | — | planned |
| — | — | Keep an approvals record for model and prompt changes: Evidence a reviewer accepts, produced automatically | gateway | build | 7 | — | — | — | planned |
| — | — | Build the inventory of AI systems in use: Purpose, owner, data class and risk level, kept current by the platform | gateway | build | 7 | — | — | — | planned |
| — | — | Produce the audit pack for one customer: Completeness, retention limits and redaction together | gateway | build | 7 | — | — | — | planned |
| — | — | Capstone: a platform three teams share: Batch, chat and sensitive-data teams onboard on one day; provider outage, noisy neighbour and audit request; every target must hold | gateway | exam | 8 | — | — | — | planned |

## Path 4: Evals and Safe Releases

`path: evals-releases`

| code | slug | title | family | type | module | order | tier | est. min | status |
|---|---|---|---|---|---|---|---|---|---|
| P4-01 | `worse-after-the-prompt-change` | A worse prompt shipped and nothing caught it | agent | build | 1 | 1 | pro | 75 | built |
| P4-02 | — | Case set from traces: Turn production traces into a regression case set | agent | build | 1 | — | — | — | planned |
| P4-03 | — | Calibrate a judge: Check an LLM judge against human labels; in-lab harness, since AI Gateway Evaluations is deprecated | agent | build | 1 | — | — | — | planned |
| P4-04 | — | Canary and rollback: Roll a change out to a slice and roll it back, using Dynamic Routing | agent | build | 1 | — | — | — | planned |
| P4-05 | — | Online guardrail monitoring: Watch live traffic for quality and safety regressions | agent | build | 1 | — | — | — | planned |
| P4-06 | — | Leakage and contamination: Find eval cases that leaked into the prompt or training data | agent | build | 1 | — | — | — | planned |

## How to add a lab

Write the lab as described in `docs/lab-authoring.md` (the manifest reference, including the catalogue fields). Then add its row to the right table here, replacing the matching `planned` row if there is one, and set `path`, `module`, `order`, `prerequisites`, `tier` and `estimated_minutes` in its manifest to match.
