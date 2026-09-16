# Outbox migrations

SQL the SDK ships to consumers. A consumer applies these in its own database
with its own migration runner. Files here are immutable once merged to `main`:
fix a mistake with a new file, never by editing an old one
(`scripts/gates/check-migration-immutability.sh`).

Naming: `<YYYYMMDDHHMMSS>_<slug>.sql`.
