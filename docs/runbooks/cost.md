# Cost runbook

What the container fleet costs, how to get told before it surprises you, and how to read `GET /usage`.

## Unit prices

Cloudflare Containers bill for the time an instance is running, per second, on three meters (Workers Paid plan; the monthly free allowance is small, so treat it as zero for planning). Verify against the current Containers pricing page before relying on these:

| Meter | Rate |
|---|---|
| vCPU | $0.000020 per vCPU-second |
| Memory | $0.0000025 per GiB-second |
| Disk | $0.00000007 per GB-second |

Per instance-hour, for the two instance types in `wrangler.jsonc`:

| Family | Instance | vCPU | Memory | Disk | $/hour | $/24h | $/30 days always-on |
|---|---|---|---|---|---|---|---|
| `agent` | `standard-1` | 0.5 | 4 GiB | 8 GB | 0.074 | 1.78 | 53.28 |
| `gateway` | custom | 1 | 8 GiB | 16 GB | 0.148 | 3.55 | 106.56 |

Worked out for the gateway: `1 x 0.00002 x 3600 = 0.072`, `8 x 0.0000025 x 3600 = 0.072`, `16 x 0.00000007 x 3600 = 0.004`, total `0.148`. These are the defaults `GET /usage` uses (`PRICE_PER_HOUR_AGENT`, `PRICE_PER_HOUR_GATEWAY`). If the instance types or Cloudflare's rates change, set those two vars (string numbers) instead of editing code.

Two costs to keep apart:

- **Session hours**: a container is billed while a learner's session runs. This is what `/usage` estimates.
- **Warm pool**: each family's `POOL_TARGET_*` containers run whether or not anyone uses them. One warm container per family, 24/7, is about $160/month (`53.28 + 106.56`), which by itself passes a $150 alert late in the month. `POOL_SCHEDULE_*` (docs/api.md, "Pool schedule") trims that: `mon-fri 06-20=1; *=0` runs 14h x 5 days, roughly 42% of always-on.

## Billing notifications ($150 and $300)

Cloudflare can email when usage-based spend crosses a threshold. It is an alert, not a cap: nothing stops containers.

1. Cloudflare dashboard -> **Notifications** (account home) -> **Add**.
2. Choose **Billing** -> **Usage Based Billing**.
3. Name it `opalix spend $150`, set the threshold to **150** USD, choose the email recipients, save.
4. Repeat with name `opalix spend $300` and threshold **300**.

Set both: $150 is "look at it this week", $300 is "something is running that should not be". When the $300 one fires, list live sessions (`GET /sessions`), check `GET /pools`, and `POST /pools/:family/drain` for any pool that should be idle.

## Cap on runaway scale-out: `max_instances`

`max_instances` is the hard ceiling on concurrently running containers per family, warm and claimed together. It is the only real cap the platform gives you. Recommended value until demand shows otherwise: **10 per family**.

```jsonc
// wrangler.jsonc -> "containers"
{ "class_name": "AgentLab",   "max_instances": 10 },
{ "class_name": "GatewayLab", "max_instances": 10 }
```

Worst case at that ceiling if every slot ran all month: `10 x 53.28 + 10 x 106.56 = $1,598`, which is why the notifications above matter. A `503 container_unavailable` on `POST /sessions` while the ceiling is reached is the signal to raise it, deliberately.

## Reading `GET /usage`

Service-key auth. `from` and `to` are epoch milliseconds; the default window is the 30 days ending now.

```
curl -H "Authorization: Bearer $KEY" "$BASE/usage"
curl -H "Authorization: Bearer $KEY" "$BASE/usage?from=1788000000000&to=1790600000000"
```

```json
{
  "from": 1788000000000,
  "to": 1790600000000,
  "by_family": {
    "agent":   { "hours": 41.5, "usd": 3.071, "sessions": 57 },
    "gateway": { "hours": 12.25, "usd": 1.813, "sessions": 19 }
  },
  "total_usd": 4.884
}
```

- `hours`: summed container-hours of sessions in D1 that overlap the window. Each session is clamped to the window (a session that began before `from` counts only from `from`; one still running counts up to `to`). Sessions that never reached `running` have no `started_at` and are not counted.
- `usd`: `hours x` the family's price per hour. `sessions` is the number of overlapping sessions.
- It is session time only. Warm-pool time is not in it; estimate that from the pool targets (table above). The invoice is the source of truth, and `/usage` is for spotting trends and a lab or cohort that costs more than expected.
- `400 bad_window` means `from`/`to` was not a number, or `from >= to`.
