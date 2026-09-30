# Backups runbook

## How workspace snapshots work today

- `snapshotNow()` in `src/session/lifecycle.ts` calls the Sandbox SDK `createBackup` for `/workspace` with `ttl: 7 * 24 * 3600`. One archive object is written to R2 (`opalix-backups`, binding `BACKUP_BUCKET`, wrangler.jsonc) under the `backups/` prefix.
- The snapshot list is kept in the Session DO storage (the source of truth for resume) and mirrored to the D1 `snapshots` table by `insertSnapshot` in `src/session/d1.ts`. `expires_at` = `created_at + ttl`.
- The 7-day TTL is metadata only. The SDK refuses to restore an expired backup but never deletes the object (see the note on `createBackup` in `@cloudflare/sandbox`). Without the lifecycle rule below, `opalix-backups` grows without bound.
- The hourly cron branch in `scheduled()` (`src/index.ts`) runs `deleteExpiredSnapshots`, which deletes D1 `snapshots` rows past `expires_at` and logs the count. It does NOT touch R2.

## R2 lifecycle rule (one-time, operator)

The bucket lifecycle rule is what actually deletes snapshot objects. Expire one day after the app TTL, scoped to the SDK prefix so future exports under `d1/` are kept:

```
npx wrangler r2 bucket lifecycle add opalix-backups expire-snapshots backups/ --expire-days 8
```

Verify:

```
npx wrangler r2 bucket lifecycle list opalix-backups
```

The output must show rule `expire-snapshots`, prefix `backups/`, 8 days. There is no staging bucket to repeat this for. Do not omit the prefix: a bucket-wide rule would also expire `d1/` exports.

## D1 backup

- Time Travel is on by default: 30-day point-in-time restore.
  - Inspect: `npx wrangler d1 time-travel info opalix`
  - Restore in place (overwrites the live database): `npx wrangler d1 time-travel restore opalix --timestamp=<RFC3339>`
  - Note the bookmark printed by `restore`; it is the undo point.
- Nightly export (belt and braces, NOT yet automated; nothing runs it today):
  1. `npx wrangler d1 export opalix --remote --output=opalix-<date>.sql`
  2. Upload it to `opalix-backups/d1/<date>.sql`.
  Time Travel only reaches back 30 days; the export is the only longer-lived copy.

## Quarterly restore drill

1. Record `npx wrangler d1 time-travel info opalix` output.
2. Export production: `npx wrangler d1 export opalix --remote --output=drill.sql`.
3. Create a scratch database: `npx wrangler d1 create opalix-drill`.
4. Load it: `npx wrangler d1 execute opalix-drill --remote --file=drill.sql`.
5. Compare row counts against production for `sessions`, `snapshots`, `check_runs`:
   `npx wrangler d1 execute opalix-drill --remote --command "SELECT COUNT(*) FROM sessions"`
6. Delete the scratch database: `npx wrangler d1 delete opalix-drill`, and delete `drill.sql`.
7. Log the date, row counts and any discrepancy in the ops log.
