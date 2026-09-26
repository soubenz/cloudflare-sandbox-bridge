"""Given infra -- not part of your task.

The document corpus shared by three fake teams (tenants) on the platform:
`acme` (sales), `globex` (security/compliance) and `northwind`
(support/ops). Some documents are deliberately close in embedding space
across tenants -- a real risk in any shared multi-tenant document store,
and exactly what your /search endpoint has to get right. Each row is
(tenant_id, doc_id, title, content).

`services/seed_db.py` loads this into pgvector at session boot. It is the
single source of truth for the corpus -- the grader's own checks re-seed an
identical copy of it into a private, throwaway database, so nothing you do
to the running `postgres` service can affect how you're graded.
"""

DOCS = [
    # ---- acme: sales team ----
    ("acme", "acme-sales-1", "Quarterly commission tiers",
     "quarterly sales commission accelerator tiers apply to enterprise reps hitting stretch quota targets each quarter"),
    ("acme", "acme-sales-2", "Commission clawback rules",
     "sales commission clawback applies when an enterprise deal cancels within the same quarter it was booked"),
    ("acme", "acme-sales-3", "Accelerator qualification",
     "enterprise reps qualify for the commission accelerator tier after three consecutive quarters above quota"),
    ("acme", "acme-filler-1", "Expense report deadline",
     "monthly expense report submission deadline for finance staff is the fifth business day"),
    ("acme", "acme-filler-2", "Travel booking policy",
     "book economy class flights for domestic travel under six hours through the approved travel portal"),
    # Near-duplicate of globex's own vendor-security document below -- this
    # sits extremely close to it in embedding space, on purpose. It belongs
    # to acme and must never come back from a globex-scoped search.
    ("acme", "acme-vendor-dup", "Vendor security questionnaire (acme copy)",
     "vendor security questionnaire annual review checklist for enterprise procurement partners"),
    # Crowd documents: near-verbatim restatements of the RMA topic below,
    # deliberately worded closer to that exact phrasing than northwind's own
    # (differently-worded) documents on the same topic are.
    ("acme", "acme-rma-crowd-1", "RMA procedure (acme)",
     "return merchandise authorization process for damaged goods official procedure document"),
    ("acme", "acme-rma-crowd-2", "RMA procedure summary (acme)",
     "official return merchandise authorization process for damaged goods summary"),
    ("acme", "acme-rma-crowd-3", "RMA steps (acme)",
     "return merchandise authorization process for damaged goods step by step guide"),

    # ---- globex: security/compliance team ----
    ("globex", "globex-vendor-1", "Vendor security questionnaire",
     "vendor security questionnaire annual review checklist for enterprise procurement"),
    ("globex", "globex-vendor-2", "Vendor risk tiering",
     "vendor risk tiering determines how often the security questionnaire must be renewed for high risk suppliers"),
    ("globex", "globex-filler-1", "Incident response contacts",
     "security incident response on call rotation and escalation contacts for the compliance team"),
    ("globex", "globex-filler-2", "Access review cadence",
     "quarterly access review of privileged accounts across production systems"),
    ("globex", "globex-rma-crowd-1", "RMA procedure (globex)",
     "return merchandise authorization process for damaged goods official procedure notes"),
    ("globex", "globex-rma-crowd-2", "RMA procedure summary (globex)",
     "official return merchandise authorization process for damaged goods overview"),
    ("globex", "globex-rma-crowd-3", "RMA steps (globex)",
     "return merchandise authorization process for damaged goods full walkthrough"),

    # ---- northwind: support/ops team ----
    ("northwind", "northwind-rma-1", "Damaged item return workflow",
     "damaged item return process workflow for defective products shipped to customers"),
    ("northwind", "northwind-rma-2", "RMA ticket handling",
     "return process handling for damaged goods rma tickets managed by support agents"),
    ("northwind", "northwind-rma-3", "Refund vs replacement policy",
     "return process for damaged goods refund or replacement policy decision"),
    ("northwind", "northwind-filler-1", "Shift handoff checklist",
     "support shift handoff checklist for the overnight on call queue"),
    ("northwind", "northwind-filler-2", "Ticket priority levels",
     "ticket priority levels and response time targets for the support queue"),
]
