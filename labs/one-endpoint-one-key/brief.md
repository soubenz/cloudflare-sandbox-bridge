# Give every team one endpoint and one key

One LiteLLM gateway fronts the model provider for the whole platform. Two
teams share it, `search` and `billing`, and each should reach only the
model aliases it was granted, never the whole catalogue. Billing also
wants its own admin who can hand out billing keys on request, without
being able to touch anything outside billing.

The gateway is up, but none of that is true yet. `platform/setup.py` is
supposed to make the running gateway match `platform/teams.yaml`; as
shipped, it does nothing.

## What you have

| Where | What |
|---|---|
| `platform/teams.yaml` | What should exist: which teams, which models each may reach, and who administers which team. You don't edit it; you make the gateway match it. |
| **`platform/setup.py`** | Yours. Reads teams.yaml, must reconcile the gateway with it, then write `platform/keys.json`. Its docstring says what it must leave behind; none of it is implemented yet. |
| `gateway/config.yaml` | The gateway's model list: `support`, `fast`, and `internal-eval`. The third is not a typo: it is the platform's own alias and is listed for no team. |
| **view** tab | Read-only: every team and its allowed models, every key's alias and last four characters (never a usable key), and the provider's own log of which calls actually reached it. |

Talk to the gateway with `curl`, as `setup.py` does; `$LITELLM_URL` and
`$LITELLM_MASTER_KEY` are in your environment.

## Your task

Make `platform/setup.py` reconcile the gateway with `platform/teams.yaml`,
then run it:

```bash
python3 -B platform/setup.py
```

When it's done, the **view** tab should show:

- `search`, allowed only `support`.
- `billing`, allowed `support` and `fast`.
- A key for each team, and a personal key for `billing-admin`.

And the gateway itself must enforce it: `billing-admin` can create a new
key for the billing team, but is refused a key on any other team and
refused anything only a platform admin can do. Nobody's key, including
`billing-admin`'s own, ever reaches `internal-eval`.

Before you reach for the obvious API: the literal "give this team member
the admin role" call is gated behind an Enterprise licence this gateway
lacks, and no config change unlocks it. The outcome you want, a team
member who can self-serve keys for their own team and nothing more, has a
different, unlicensed path.

## Checking your work

**Run checks** never reads your code. It starts its own LiteLLM on a fresh
database with your current `gateway/config.yaml`, runs *your*
`platform/setup.py` against it, and calls the result with whatever keys
came out, as any real caller would.

| Check | Passes when |
|---|---|
| `team-keys-reach-only-their-models` | `search`'s key reaches `support` and is refused on `fast`; `billing`'s reaches both; neither reaches `internal-eval`. |
| `team-admin-stays-in-its-lane` | `billing-admin`'s key can create a working billing key, is refused creating one for `search`, and is refused on `GET /user/list`. |
| `no-one-holds-the-master-key` | None of the three keys in `platform/keys.json` is the master key, and none can act as a platform admin (by role or by what it can call). |

The third check stops the first two being met the easy way: handing every
team the master key, or making `billing-admin` a platform admin, would
pass them trivially. You need all three.
