#!/usr/bin/env bash
# Static checks on the engine's fly.toml (#176). Run: bash infra/hatchet/fly/config.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
FLY_TOML="${SCRIPT_DIR}/fly.toml"
COMPOSE="${SCRIPT_DIR}/../compose.yaml"

echo "=== engine fly.toml self-tests ==="
assert_exit "fly.toml exists" 0 test -f "${FLY_TOML}"

assert_output_contains "queue kind is rabbitmq" "SERVER_MSGQUEUE_KIND = 'rabbitmq'" cat "${FLY_TOML}"
assert_output_contains "config mount stays kyu_hatchet_config_2x" "source = 'kyu_hatchet_config_2x'" cat "${FLY_TOML}"
assert_output_lacks "no amqp URL" "amqp://" cat "${FLY_TOML}"
assert_output_lacks "no RabbitMQ URL value" "SERVER_MSGQUEUE_RABBITMQ_URL =" cat "${FLY_TOML}"

FLY_TAG="$(sed -nE "s#^  image = 'ghcr.io/hatchet-dev/hatchet/hatchet-lite:(v[0-9.]+)'\$#\1#p" "${FLY_TOML}")"
COMPOSE_TAG="$(sed -nE 's#.*hatchet-lite:\$\{KYU_HATCHET_IMAGE_TAG:-(v[0-9.]+)\}.*#\1#p' "${COMPOSE}")"
gate_test_record "an engine image tag is pinned" "$([ -n "${FLY_TAG}" ] && echo 0 || echo 1)"
assert_eq "fly.toml and compose.yaml pin the same hatchet-lite tag" "${FLY_TAG}" "${COMPOSE_TAG}"

gate_test_finish
