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
printf 'CREATE TABLE public.t (id uuid);\n' > "${WORK}/clean/20260101000000_base.sql"
assert_exit "clean migration passes" 0 env MIGRATIONS_DIR="${WORK}/clean" bash "${CHECK}"

mkdir -p "${WORK}/line_comment"
printf 'CREATE TABLE public.t (id uuid);\n-- COMMIT this later\n' > "${WORK}/line_comment/20260101000000_base.sql"
assert_exit "-- line comment with COMMIT passes" 0 env MIGRATIONS_DIR="${WORK}/line_comment" bash "${CHECK}"

mkdir -p "${WORK}/block_comment"
printf 'CREATE TABLE public.t (id uuid);\n/* BEGIN */\n' > "${WORK}/block_comment/20260101000000_base.sql"
assert_exit "/* BEGIN */ block comment passes" 0 env MIGRATIONS_DIR="${WORK}/block_comment" bash "${CHECK}"

mkdir -p "${WORK}/plpgsql"
cat > "${WORK}/plpgsql/20260101000000_trigger.sql" <<'SQL'
CREATE FUNCTION public.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
SQL
assert_exit "PL/pgSQL BEGIN ... END in a \$\$ body passes" 0 env MIGRATIONS_DIR="${WORK}/plpgsql" bash "${CHECK}"

mkdir -p "${WORK}/tagged_dollar"
cat > "${WORK}/tagged_dollar/20260101000000_trigger.sql" <<'SQL'
CREATE FUNCTION public.touch_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
SQL
assert_exit "\$fn\$ ... \$fn\$ body passes" 0 env MIGRATIONS_DIR="${WORK}/tagged_dollar" bash "${CHECK}"

mkdir -p "${WORK}/string_literal"
printf "INSERT INTO public.t (label) VALUES ('COMMIT');\n" > "${WORK}/string_literal/20260101000000_seed.sql"
assert_exit "string literal 'COMMIT' passes" 0 env MIGRATIONS_DIR="${WORK}/string_literal" bash "${CHECK}"

mkdir -p "${WORK}/midline"
printf 'CREATE TABLE a(x int); ROLLBACK;\n' > "${WORK}/midline/20260101000001_bad.sql"
assert_exit "mid-line ROLLBACK fails" 1 env MIGRATIONS_DIR="${WORK}/midline" bash "${CHECK}"
assert_output_contains "failure names the file" "20260101000001_bad.sql" env MIGRATIONS_DIR="${WORK}/midline" bash "${CHECK}"

mkdir -p "${WORK}/firstline"
printf 'COMMIT;\nCREATE TABLE public.t (id uuid);\n' > "${WORK}/firstline/20260101000001_bad.sql"
assert_exit "first-line COMMIT fails" 1 env MIGRATIONS_DIR="${WORK}/firstline" bash "${CHECK}"

mkdir -p "${WORK}/concurrently"
printf 'CREATE INDEX CONCURRENTLY idx_t_x ON public.t (x);\n' > "${WORK}/concurrently/20260101000001_bad.sql"
assert_exit "CREATE INDEX CONCURRENTLY fails" 1 env MIGRATIONS_DIR="${WORK}/concurrently" bash "${CHECK}"
assert_output_contains "CONCURRENTLY failure names the reason" \
  "cannot run inside the per-file transaction that runners apply migrations in" \
  env MIGRATIONS_DIR="${WORK}/concurrently" bash "${CHECK}"

mkdir -p "${WORK}/missing_parent/does-not-exist"
rm -rf "${WORK}/missing_parent/does-not-exist"
assert_exit "missing migrations dir passes" 0 env MIGRATIONS_DIR="${WORK}/missing_parent/does-not-exist" bash "${CHECK}"

gate_test_finish
