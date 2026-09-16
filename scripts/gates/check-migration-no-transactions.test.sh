#!/usr/bin/env bash
# Run: bash scripts/gates/check-migration-no-transactions.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-migration-no-transactions.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== check-migration-no-transactions tests ==="

mkdir -p "${WORK}/clean"
printf 'CREATE TABLE public.t (id uuid);\n-- COMMIT this later\n' > "${WORK}/clean/20260101000000_base.sql"
assert_exit "clean migration passes; commented COMMIT is ignored" 0 env MIGRATIONS_DIR="${WORK}/clean" bash "${CHECK}"

mkdir -p "${WORK}/dirty"
printf 'BEGIN;\nCREATE TABLE public.t (id uuid);\nCOMMIT;\n' > "${WORK}/dirty/20260101000001_bad.sql"
assert_exit "COMMIT in migration fails" 1 env MIGRATIONS_DIR="${WORK}/dirty" bash "${CHECK}"
assert_output_contains "failure names the file" "20260101000001_bad.sql" env MIGRATIONS_DIR="${WORK}/dirty" bash "${CHECK}"

mkdir -p "${WORK}/empty"
assert_exit "empty migrations dir passes" 0 env MIGRATIONS_DIR="${WORK}/empty" bash "${CHECK}"

mkdir -p "${WORK}/missing_parent/does-not-exist"
rm -rf "${WORK}/missing_parent/does-not-exist"
assert_exit "missing migrations dir passes" 0 env MIGRATIONS_DIR="${WORK}/missing_parent/does-not-exist" bash "${CHECK}"

gate_test_finish
