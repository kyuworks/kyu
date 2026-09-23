#!/usr/bin/env bash
# Static checks on fly.toml, Dockerfile and harness.dockerignore (#166). Run:
# bash infra/shop-harness/fly/config.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
FLY_TOML="${SCRIPT_DIR}/fly.toml"
DOCKERFILE="${SCRIPT_DIR}/Dockerfile"
IGNOREFILE="${SCRIPT_DIR}/harness.dockerignore"

echo "=== config self-tests ==="
assert_exit "fly.toml exists" 0 test -f "${FLY_TOML}"
assert_exit "Dockerfile exists" 0 test -f "${DOCKERFILE}"
assert_exit "harness.dockerignore exists" 0 test -f "${IGNOREFILE}"

# --- fly.toml ---
assert_output_lacks "no [[services]] block" "[[services]]" cat "${FLY_TOML}"
assert_output_lacks "no [http_service] block" "[http_service]" cat "${FLY_TOML}"
assert_output_contains "restart policy is never" "policy = 'never'" cat "${FLY_TOML}"
assert_output_contains "primary region is syd" "primary_region = 'syd'" cat "${FLY_TOML}"
assert_output_contains "vm size is performance-2x" "size = 'performance-2x'" cat "${FLY_TOML}"
assert_output_contains "HATCHET_CLIENT_HOST_PORT is the engine's internal address" \
  "<engine-app>.internal:7077" bash -c "grep HATCHET_CLIENT_HOST_PORT '${FLY_TOML}'"
assert_output_contains "HATCHET_CLIENT_API_URL is the engine's internal address" \
  "http://<engine-app>.internal:8888" bash -c "grep HATCHET_CLIENT_API_URL '${FLY_TOML}'"
assert_output_contains "TLS strategy is none" "HATCHET_CLIENT_TLS_STRATEGY = 'none'" cat "${FLY_TOML}"

# --- Dockerfile ---
assert_output_contains "based on node:24-" "FROM node:24-" cat "${DOCKERFILE}"
assert_output_contains "installs the pinned pnpm" "pnpm@11.24.0" cat "${DOCKERFILE}"
assert_output_contains "installs with --frozen-lockfile" "--frozen-lockfile" cat "${DOCKERFILE}"
assert_output_contains "fails the build with no commit sha" 'test -n "$KYU_HARNESS_COMMIT_SHA"' cat "${DOCKERFILE}"

# --- harness.dockerignore ---
assert_output_contains "re-includes infra/hatchet/compose.yaml" "infra/hatchet/compose.yaml" cat "${IGNOREFILE}"
assert_output_contains "re-includes run.sh" "infra/shop-harness/fly/run.sh" cat "${IGNOREFILE}"
assert_output_contains "re-excludes .env files" "**/.env*" cat "${IGNOREFILE}"
REINCLUDE_LINE="$(grep -n '^!examples/shop/\*\*$' "${IGNOREFILE}" | head -1 | cut -d: -f1)"
ENV_EXCLUDE_LINE="$(grep -n '^\*\*/\.env\*$' "${IGNOREFILE}" | head -1 | cut -d: -f1)"
gate_test_record "env re-exclude comes after the examples/shop/** re-include" \
  "$([ -n "${REINCLUDE_LINE}" ] && [ -n "${ENV_EXCLUDE_LINE}" ] && [ "${ENV_EXCLUDE_LINE}" -gt "${REINCLUDE_LINE}" ] && echo 0 || echo 1)"

gate_test_finish
