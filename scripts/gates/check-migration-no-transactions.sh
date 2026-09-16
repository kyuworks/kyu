#!/usr/bin/env bash
# check-migration-no-transactions.sh — a migration file must not contain its
# own transaction control statements; the applier wraps each file in one
# transaction (packages/sdk/vitest.integration.setup.ts), and a consumer's
# runner does the same.
#
# Blocked, case-insensitive, `--` line comments stripped first:
#   BEGIN | COMMIT | ROLLBACK | SAVEPOINT | START TRANSACTION | END
#
# Env: MIGRATIONS_DIR (default: <root>/packages/sdk/migrations)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-${ROOT_DIR}/packages/sdk/migrations}"
echo "=== migration no-transactions gate ==="

[ -d "${MIGRATIONS_DIR}" ] || { echo "OK: no migrations directory."; exit 0; }

PATTERN='^[[:space:]]*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|START TRANSACTION|END)\b'
FAIL=0
shopt -s nullglob
for file in "${MIGRATIONS_DIR}"/*.sql; do
  # Strip `--` line comments before matching, so `-- COMMIT` passes.
  HITS="$(sed -E 's/--.*$//' "${file}" | grep -inE "${PATTERN}" || true)"
  if [ -n "${HITS}" ]; then
    echo "FAIL: transaction statement in migration: ${file}" >&2
    printf '%s\n' "${HITS}" | sed 's/^/  /' >&2
    FAIL=1
  fi
done
shopt -u nullglob

if [ "${FAIL}" -ne 0 ]; then
  echo "Remove BEGIN/COMMIT/ROLLBACK/SAVEPOINT/START TRANSACTION/END. The applier wraps each file in its own transaction." >&2
  exit 1
fi
echo "OK: no transaction statements in ${MIGRATIONS_DIR}."
