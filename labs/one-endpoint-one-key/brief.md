# Give every team one endpoint and one key

One LiteLLM gateway sits in front of the model provider for the whole
platform. Two teams share it -- `search` and `billing` -- and each is
supposed to reach only the model aliases it was actually granted, never the
whole catalogue. Billing also wants to stop asking the platform team every
time someone new joins and needs a key: they want their own admin who can
hand out billing keys on request, without that admin becoming able to touch
anything outside billing.

Right now the gateway is up, but none of that is true yet. `platform/setup.py`
is supposed to make the running gateway match `platform/teams.yaml`; as
shipped, it does nothing.

## What you have

| Where | What |
|---|---|
| `platform/teams.yaml` | The platform's own record of what should exist: which teams, which models each may reach, and who administers which team. You don't edit this to make the lab pass -- you make the gateway match it. |
| `platform/setup.py` | Reads teams.yaml and is supposed to reconcile the gateway with it, then write `platform/keys.json`. Its docstring says what it must leave behind; none of it is implemented yet. |
| `gateway/config.yaml` | The gateway's model list: `support`, `fast`, and `internal-eval`. The third one is not a typo -- it's the platform's own alias and is not listed for any team. |
| **view** tab | Read-only: every team and its allowed models, every key's alias and last four characters (never a usable key), and the provider's own log of which calls actually reached it. |

You talk to the gateway itself with `curl`, the same way `setup.py` does --
`$LITELLM_URL` and `$LITELLM_MASTER_KEY` are both in your environment.

## Your task

Make `platform/setup.py` actually reconcile the gateway with
`platform/teams.yaml`, then run it:

```bash
python3 -B platform/setup.py
```

When it's done, the **view** tab should show:

- `search`, allowed only `support`.
- `billing`, allowed `support` and `fast`.
- A key for each team, and a personal key for `billing-admin`.

And the gateway itself should actually enforce all of this: `billing-admin`
can create a new key for the billing team on request, but is refused if
asked for a key on any other team, and is refused on anything that only a
platform admin can do. Nobody's key -- not `search`'s, not `billing`'s, not
`billing-admin`'s own -- ever reaches `internal-eval`.

One thing worth knowing before you reach for the obvious API: the literal
"give this team member the admin role" call is gated behind an Enterprise
licence this gateway doesn't have, and no config change unlocks it. The
outcome you want -- a team member who can self-serve keys for their own
team, and nothing more -- has a different, unlicensed path.

## Checking your work

**Run checks** never reads your code. It starts its own LiteLLM against a
fresh, empty database, points it at your current `gateway/config.yaml`,
runs *your* `platform/setup.py` against that fresh gateway, and then calls
it with whatever keys came out -- the same way any real caller would.

| Check | Passes when |
|---|---|
| `team-keys-reach-only-their-models` | `search`'s key reaches `support` and is refused on `fast`; `billing`'s key reaches both `support` and `fast`; neither reaches `internal-eval`. |
| `team-admin-stays-in-its-lane` | `billing-admin`'s own key can create a new, working key for the billing team, but is refused creating one for `search`, and is refused on `GET /user/list`. |
| `no-one-holds-the-master-key` | None of the three keys in `platform/keys.json` is the literal master key, and none of them can act as a platform admin (by role or by what it can actually call). |

The third check exists to stop the first two being satisfied the easy way
-- handing every team the master key, or making `billing-admin` an actual
platform admin, would otherwise pass "reaches its own models" and "can
self-serve" trivially. You need all three.
