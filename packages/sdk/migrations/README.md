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

## Grants

| Caller | Table | Privileges |
|---|---|---|
| `publish()` | `kyu_outbox` | INSERT |
| relay | `kyu_outbox` | SELECT, UPDATE |
| `prunePublished` | `kyu_outbox` | DELETE, SELECT |
| `pruneRetired` | `kyu_outbox` | DELETE, SELECT |
| `onceById` | `kyu_processed` | INSERT, SELECT |

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
- `20260920232955_outbox_dead_at.sql` drops and recreates `kyu_outbox_pending_idx`, which holds an ACCESS EXCLUSIVE lock on `kyu_outbox` for the rebuild; on a pruned table that is milliseconds.
