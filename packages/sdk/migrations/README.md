# Outbox migrations

SQL the SDK ships to consumers. A consumer applies these in its own database
with its own migration runner. Files here are immutable once merged to `main`:
fix a mistake with a new file, never by editing an old one
(`scripts/gates/check-migration-immutability.sh`).

Naming: `<YYYYMMDDHHMMSS>_<slug>.sql`.

## Rules

- Files run inside one transaction per file. The harness (`packages/sdk/src/db/applyMigrations.ts`) verifies at apply time that each file leaves the transaction it was opened in: it records the transaction id before and after running the file and fails if the id is gone or changed, so `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` or a similar statement inside a file is caught. `CREATE INDEX CONCURRENTLY` fails the same way, because Postgres refuses to run it inside a transaction block. PL/pgSQL bodies (`BEGIN ... END;` inside a `$$` function body) are fine — they never touch the outer transaction.
