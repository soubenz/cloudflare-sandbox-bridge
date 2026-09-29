# Build the page where teams request access

Teams that want to use the shared LiteLLM gateway aren't supposed to get a
model key just by asking for one -- they submit a request, someone with
real approval authority signs off, and only then does the gateway actually
grant anything. There's no ticket queue behind this: the portal itself
tracks the request from submission to approval and is the thing that talks
to the gateway.

`workspace/portal/app.py` already implements most of this. Read it before
you touch anything.

## What you have

| Where | What |
|---|---|
| `portal/app.py` | The portal service: three endpoints, a small SQLite database of its own, and the LiteLLM admin calls that actually grant access. This is the file you're fixing. |
| `portal/models.yaml` | The catalog of models a team may request. `POST /requests` refuses any model name that isn't listed here. |
| `gateway/config.yaml` | The gateway's model list. Not yours to edit for this lab. |
| `$LITELLM_URL`, `$LITELLM_MASTER_KEY`, `$APPROVER_TOKEN`, `$PORTAL_URL` | In your shell's environment already. |

## The three endpoints

```
POST /requests
  {"team": "...", "models_needed": ["...", ...], "justification": "..."}
  -> 201 {"id": <n>, "status": "pending", ...}

POST /requests/{id}/approve
  Header: Authorization: Bearer <token>
  Only $APPROVER_TOKEN is accepted. On success, the portal talks to
  LiteLLM's own admin API right there in the request -- the team is
  created (or extended, if it already has other models) and a real key is
  minted for it.
  -> 200 {"id": <n>, "status": "approved", "key": "sk-...", ...}

GET /requests/{id}
  -> the request's current status, and once approved, the real key.
```

Try the whole flow with curl:

```bash
curl -s -X POST $PORTAL_URL/requests \
  -d '{"team": "growth", "models_needed": ["docs-writer"], "justification": "drafting release notes"}'

curl -s -X POST $PORTAL_URL/requests/1/approve \
  -H "Authorization: Bearer $APPROVER_TOKEN"

curl -s $PORTAL_URL/requests/1
```

The key that comes back from a real approval actually works against
`$LITELLM_URL/chat/completions` -- and only for the models that request
actually named.

## Your task

Something in the approval flow lets a single approval action grant access
more than once. Find it, and fix `portal/app.py` so that approving a
request -- no matter how many times, or how close together, someone (or
something retrying a timed-out call) calls
`POST /requests/{id}/approve` for it -- provisions LiteLLM access exactly
once.

You don't need to change what gets granted or who may approve -- both of
those already work correctly. You're looking for the part of the flow that
isn't safe to call twice.

After you edit `portal/app.py`, restart the `portal` service from the
Services panel (or `POST /sessions/{id}/services/portal/restart`) to pick
up your change.

## Checking your work

**Run checks** never reads your code. It starts its own LiteLLM against a
fresh, empty database, and its own copy of your *current*
`portal/app.py` against a fresh SQLite database, then calls it the same
way any real caller would.

| Check | Passes when |
|---|---|
| `request-grants-nothing-yet` | A freshly submitted, unapproved request is `pending`, has no key, and no LiteLLM team exists for its `team` yet. |
| `approval-grants-exactly-the-requested-models` | Approving with the real approver credential returns a working key that reaches exactly the models that request named -- not a model it didn't ask for, and never the platform's own `platform-internal` alias. |
| `only-the-approver-can-approve` | Approving with no credential is refused with `401`; approving with the wrong credential is refused with `403`; either way nothing is granted, and the real approver credential still works right afterward. |
| `approving-twice-does-not-double-provision` | Approving the same request twice -- back to back, and as two calls fired at the same instant -- leaves exactly one LiteLLM team and exactly one LiteLLM key for it, confirmed against LiteLLM's own admin API, not the portal's own database. |

The last check is the one this lab is actually about. The other three
describe behaviour the skeleton already gets right -- they're there so a
fix that happens to also break who can approve, or what gets granted,
doesn't quietly pass anyway.
