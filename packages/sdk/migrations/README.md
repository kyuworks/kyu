# Outbox migrations

SQL the SDK ships to consumers. A consumer applies these in its own database
with its own migration runner. Files here are immutable once merged to `main`:
fix a mistake with a new file, never by editing an old one
(`scripts/gates/check-migration-immutability.sh`).

Naming: `<YYYYMMDDHHMMSS>_<slug>.sql`.

## Files

| File | Purpose |
|---|---|
| `20260916233209_create_outbox.sql` | `kyu_outbox` (the producer-side outbox `publish()` writes to and the relay ships) and `kyu_processed` (the consumer-side processed-id table `onceById()` uses) |
| `20260920232955_outbox_dead_at.sql` | `kyu_outbox.dead_at`: the relay retires a row whose envelope never parses, so it leaves the pending index and can be inspected and pruned. Recreates `kyu_outbox_pending_idx` with `dead_at IS NULL` in its predicate |
| `20260922022251_outbox_publish_at.sql` | `kyu_outbox.publish_at`: the earliest time the relay may ship a row, defaulting to `now()`. Recreates `kyu_outbox_pending_idx` leading on `(publish_at, created_at)` so a backlog of future rows is never scanned by the claim |
| `20260924114140_outbox_cancelled_at.sql` | `kyu_outbox.cancelled_at`: a runs cancel given the caller's transaction marks a row the relay has not claimed, so the relay never ships it (until #185 only rows not yet due; the file's own comment still says so). Recreates `kyu_outbox_pending_idx` with `cancelled_at IS NULL` in its predicate |
| `20260924124242_paused_tenant.sql` | `kyu_paused_tenant`: one row per paused business tenant; the relay's claim skips that tenant's outbox rows |

## Grants

| Caller | Table | Privileges |
|---|---|---|
| `publish()` | `kyu_outbox` | INSERT |
| relay | `kyu_outbox` | SELECT, UPDATE |
| `prunePublished` | `kyu_outbox` | DELETE, SELECT |
| `pruneRetired` | `kyu_outbox` | DELETE, SELECT |
| `pruneCancelled` | `kyu_outbox` | DELETE, SELECT |
| `pruneOutbox` | `kyu_outbox` | DELETE, SELECT |
| `runs.cancelFor*` with `outbox` | `kyu_outbox` | SELECT, UPDATE |
| `onceById` | `kyu_processed` | INSERT, SELECT |
| `tenants.pause` / `tenants.resume` | `kyu_paused_tenant` | INSERT / DELETE |
| `tenants.isPaused`, relay | `kyu_paused_tenant` | SELECT |

`kyu_outbox.tenant_id` is `uuid`: business tenant ids must be UUIDs,
matching the envelope schema.

Statements in this file are not schema-qualified, so the tables land on
whatever schema is first on the runner's `search_path`.

Handler names in `kyu_processed.handler` are stable identifiers: renaming a
handler makes it re-process every envelope it already handled under the old
name.

## Rules

- Files run inside one transaction per file. The harness (`packages/sdk/src/db/applyMigrations.ts`) verifies at apply time that each file leaves the transaction it was opened in: it records the transaction id before and after running the file and fails if the id is gone or changed, so `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` or a similar statement inside a file is caught. `CREATE INDEX CONCURRENTLY` fails the same way, because Postgres refuses to run it inside a transaction block. PL/pgSQL bodies (`BEGIN ... END;` inside a `$$` function body) are fine — they never touch the outer transaction.
- Apply a new file before deploying the SDK version that ships it: the relay's claim query references `dead_at` and errors with `column "dead_at" does not exist` until the column exists.
- Apply `20260922022251_outbox_publish_at.sql` before deploying the SDK version that ships it: the relay's claim references `publish_at` and errors with `column "publish_at" does not exist` until the column exists. The `DROP INDEX`/`CREATE INDEX` pair takes an ACCESS EXCLUSIVE lock for the rebuild, as `20260920232955` already does.
- Apply `20260924114140_outbox_cancelled_at.sql` before deploying the SDK version that ships it: the claim references `cancelled_at` and errors with `column "cancelled_at" does not exist` until it exists. The index rebuild takes the same ACCESS EXCLUSIVE lock as the earlier two.
- Rolling back the SDK version that ships `20260924114140_outbox_cancelled_at.sql` (or running it beside an older SDK version during a mixed rolling deploy) does not stop a cancelled row from shipping: an old relay's claim query does not know about `cancelled_at` and ships the row once it falls due, resuming a workflow a cancel had already stopped. Before rolling back, either set `dead_at` on the cancelled rows (`UPDATE kyu_outbox SET dead_at = now() WHERE cancelled_at IS NOT NULL AND published_at IS NULL`, which also removes them from the pending index) or delete them.
- `20260920232955_outbox_dead_at.sql` drops and recreates `kyu_outbox_pending_idx`, which holds an ACCESS EXCLUSIVE lock on `kyu_outbox` for the rebuild; on a pruned table that is milliseconds. `20260924114140_outbox_cancelled_at.sql` does the same: an old SDK's claim no longer matches the narrower predicate and falls back to a table scan until a later migration restores an index its `WHERE` implies.
- Apply `20260924124242_paused_tenant.sql` before deploying the SDK version that ships it: the claim references `kyu_paused_tenant` and errors with `relation "kyu_paused_tenant" does not exist` until it exists. Rolling back to an older SDK, or running one beside it, ships a paused tenant's rows: the old claim does not read the table.
