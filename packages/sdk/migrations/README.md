# Outbox migrations

SQL the SDK ships to consumers. A consumer applies these in its own database
with its own migration runner. Files here are immutable once merged to `main`:
fix a mistake with a new file, never by editing an old one
(`scripts/gates/check-migration-immutability.sh`).

Naming: `<YYYYMMDDHHMMSS>_<slug>.sql`.

## Files

| File | Purpose |
|---|---|
| `20260916233209_create_outbox.sql` | `kinesin_outbox` (the producer-side outbox `publish()` writes to and the relay ships) and `kinesin_processed` (the consumer-side processed-id table `onceById()` uses) |

## Grants

| Caller | Table | Privileges |
|---|---|---|
| `publish()` | `kinesin_outbox` | INSERT |
| relay | `kinesin_outbox` | SELECT, UPDATE |
| `prunePublished` | `kinesin_outbox` | DELETE, SELECT |
| `onceById` | `kinesin_processed` | INSERT, SELECT |

`kinesin_outbox.tenant_id` is `uuid`: business tenant ids must be UUIDs,
matching the envelope schema.

Statements in this file are not schema-qualified, so the tables land on
whatever schema is first on the runner's `search_path`.

Handler names in `kinesin_processed.handler` are stable identifiers: renaming a
handler makes it re-process every envelope it already handled under the old
name.

## Rules

- Files run inside one transaction per file. The harness (`packages/sdk/src/db/applyMigrations.ts`) verifies at apply time that each file leaves the transaction it was opened in: it records the transaction id before and after running the file and fails if the id is gone or changed, so `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` or a similar statement inside a file is caught. `CREATE INDEX CONCURRENTLY` fails the same way, because Postgres refuses to run it inside a transaction block. PL/pgSQL bodies (`BEGIN ... END;` inside a `$$` function body) are fine — they never touch the outer transaction.
