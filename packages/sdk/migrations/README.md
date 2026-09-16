# Outbox migrations

SQL the SDK ships to consumers. A consumer applies these in its own database
with its own migration runner. Files here are immutable once merged to `main`:
fix a mistake with a new file, never by editing an old one
(`scripts/gates/check-migration-immutability.sh`).

Naming: `<YYYYMMDDHHMMSS>_<slug>.sql`.

## Rules

- Files run inside one transaction per file, so a migration file must not contain `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `START TRANSACTION`, `END` or `PREPARE TRANSACTION`, and must not use `CREATE INDEX CONCURRENTLY`, which cannot run inside that transaction. The gate `scripts/gates/check-migration-no-transactions.sh` enforces both. PL/pgSQL bodies (`BEGIN ... END;` inside a `$$` function body) are fine.
