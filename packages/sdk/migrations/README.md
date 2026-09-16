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
| `prunePublished` | `kinesin_outbox` | DELETE |
| `onceById` | `kinesin_processed` | INSERT, SELECT |

Handler names in `kinesin_processed.handler` are stable identifiers: renaming a
handler makes it re-process every envelope it already handled under the old
name.
