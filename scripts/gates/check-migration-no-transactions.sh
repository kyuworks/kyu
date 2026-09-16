#!/usr/bin/env bash
# check-migration-no-transactions.sh — a migration file must not contain its
# own transaction control statements; the applier wraps each file in one
# transaction (packages/sdk/vitest.integration.setup.ts), and a consumer's
# runner does the same. Also blocks CREATE INDEX CONCURRENTLY, which cannot
# run inside that per-file transaction.
#
# Tokenizer lives in check-migration-no-transactions.mjs (strips comments,
# strings and dollar-quoted bodies before checking each statement's leading
# keyword), so a PL/pgSQL `BEGIN ... END;` body or a `'COMMIT'` string
# literal does not trip the gate.
#
# Env: MIGRATIONS_DIR (default: <root>/packages/sdk/migrations)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
export MIGRATIONS_DIR="${MIGRATIONS_DIR:-${ROOT_DIR}/packages/sdk/migrations}"
echo "=== migration no-transactions gate ==="

exec node "$(dirname "$0")/check-migration-no-transactions.mjs"
