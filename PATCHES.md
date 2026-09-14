# Live patches

The actual `WarmPool` Durable Object (assignment tracking, pool scaling,
`getSandboxStub`, `configure`) is **not** in this repo — it's compiled into the
`@cloudflare/sandbox` npm package (`packages/sandbox/src/bridge/warm-pool.ts`
in [cloudflare/sandbox-sdk](https://github.com/cloudflare/sandbox-sdk)).
`src/index.ts` here is just the thin wrapper upstream ships in
`bridge/worker/src/index.ts`.

Two behavioural changes have been applied directly to the deployed Worker
bundle (via a script-level GET → patch → PUT round trip against the Cloudflare
API, not a `wrangler deploy` from this repo — there is no working build
pipeline here, this file is a record of what's actually live). If this Worker
is ever redeployed from a real `wrangler deploy` / fresh `@cloudflare/sandbox`
install, these two patches need to be reapplied by hand (e.g. via
`patch-package`) or they will silently disappear.

Deployed script: `cloudflare-sandbox-bridge-2` (Cloudflare account
`map-platform`, worker name differs from this repo's `name` field).

## 1. Configurable sandbox placement (`getSandboxStub`)

Upstream has no way to influence where a sandbox's container is scheduled —
placement is always nearest-to-request. We needed to steer sandboxes toward a
specific region without a hard compliance/jurisdiction requirement, so
`locationHint` (best-effort, does not change the Durable Object ID — unlike
`jurisdiction`, existing pool bookkeeping keeps working across the change) is
the right primitive.

```ts
// before (upstream)
private getSandboxStub(containerUUID: string): DurableObjectStub {
  const id = this.env.Sandbox.idFromName(containerUUID);
  return this.env.Sandbox.get(id);
}

// after (patched)
private getSandboxStub(containerUUID: string): DurableObjectStub {
  const id = this.env.Sandbox.idFromName(containerUUID);
  const locationHint = this.env.SANDBOX_LOCATION_HINT;
  return locationHint ? this.env.Sandbox.get(id, { locationHint }) : this.env.Sandbox.get(id);
}
```

Driven by the new `SANDBOX_LOCATION_HINT` var (see `wrangler.jsonc`). Change
region by editing that var and redeploying — no code change needed. Unset it
to fall back to upstream's default nearest-to-request placement.

Verified: forced a fresh container via `shutdown-prewarmed` + `prime` and
confirmed it landed in `WEUR` (Marseille then London), vs. `ENAM` before the
patch.

## 2. `maxInstances` ceiling doesn't self-heal (`configure`)

`knownMaxInstances` is learned reactively from real Cloudflare capacity
errors (`recordCapacityLimit`), then in upstream `configure()` only ever
ratchets **down** via `Math.min(knownMaxInstances, config.maxInstances)` —
raising `WARM_POOL_MAX_INSTANCES` afterward has no effect, since the stale
learned value is always the smaller of the two. We hit this: the pool learned
a ceiling of 100 once, then stayed capped at 100 even after
`WARM_POOL_MAX_INSTANCES` was raised to 500.

```ts
// before (upstream)
if (this.config.maxInstances > 0) {
  this.knownMaxInstances =
    this.knownMaxInstances === null
      ? this.config.maxInstances
      : Math.min(this.knownMaxInstances, this.config.maxInstances);
  await this.ctx.storage.put('knownMaxInstances', this.knownMaxInstances);
}

// after (patched)
if (this.config.maxInstances > 0) {
  const configuredMax = this.config.maxInstances;
  const lastConfiguredMax = await this.ctx.storage.get('lastConfiguredMaxInstances');
  if (lastConfiguredMax !== configuredMax) {
    // Operator explicitly changed the config — the old learned ceiling no
    // longer applies, so drop it and start learning fresh.
    this.knownMaxInstances = configuredMax;
    this.capacityExhausted = false;
    await this.ctx.storage.put('lastConfiguredMaxInstances', configuredMax);
  } else {
    this.knownMaxInstances =
      this.knownMaxInstances === null ? configuredMax : Math.min(this.knownMaxInstances, configuredMax);
  }
  await this.ctx.storage.put('knownMaxInstances', this.knownMaxInstances);
}
```

Still keeps the reactive learning behaviour within a given configuration (so
it won't hammer the platform); it only discards the stale lesson when the
operator actually changes `WARM_POOL_MAX_INSTANCES`. `configure()` runs on
every request, so the reset is immediate.

Verified: `/v1/pool/stats` reported `maxInstances: 100` before the patch,
`500` immediately after, stable across repeated calls.
