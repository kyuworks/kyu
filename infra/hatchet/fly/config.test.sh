#!/usr/bin/env bash
# Static checks on the engine's fly.toml and the runbook names that must match it. Run: bash infra/hatchet/fly/config.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
FLY_TOML="${SCRIPT_DIR}/fly.toml"
COMPOSE="${SCRIPT_DIR}/../compose.yaml"
RUNBOOK="${SCRIPT_DIR}/../../../docs/operations/kyu-engine-on-fly.md"

echo "=== engine fly.toml self-tests ==="
assert_exit "fly.toml exists" 0 test -f "${FLY_TOML}"

assert_output_contains "queue kind is rabbitmq" "SERVER_MSGQUEUE_KIND = 'rabbitmq'" cat "${FLY_TOML}"
assert_output_contains "config mount stays kyu_hatchet_config_2x" "source = 'kyu_hatchet_config_2x'" cat "${FLY_TOML}"

# First deploy step 4 creates the volume fly.toml mounts; keep that command on one line, with `-a <engine-app>` last.
MOUNT_SOURCE="$(sed -nE "s#^  source = '([^']+)'\$#\1#p" "${FLY_TOML}")"
RUNBOOK_VOLUME="$(sed -nE 's#.*`fly volumes create ([a-z0-9_]+) .*-a <engine-app>`.*#\1#p' "${RUNBOOK}")"
assert_eq "the runbook creates the volume fly.toml mounts" "${MOUNT_SOURCE}" "${RUNBOOK_VOLUME}"
OTHER_VOLUMES="$(grep -noE 'kyu_hatchet_config[a-z0-9_]*' "${RUNBOOK}" | grep -vE ":${MOUNT_SOURCE}\$")"
assert_eq "the runbook names no other engine config volume" "" "${OTHER_VOLUMES}"

assert_output_lacks "no amqp URL" "amqp://" cat "${FLY_TOML}"
assert_output_lacks "no RabbitMQ URL value" "SERVER_MSGQUEUE_RABBITMQ_URL =" cat "${FLY_TOML}"
# Checked at login too; the dev engine rebuild (runbook step 11) put the admin account on this domain.
assert_output_contains "signup and login are restricted to the company domain" "SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS = '<company-domain>'" cat "${FLY_TOML}"

FLY_TAG="$(sed -nE "s#^  image = 'ghcr.io/hatchet-dev/hatchet/hatchet-lite:(v[0-9.]+)'\$#\1#p" "${FLY_TOML}")"
COMPOSE_TAG="$(sed -nE 's#.*hatchet-lite:\$\{KYU_HATCHET_IMAGE_TAG:-(v[0-9.]+)\}.*#\1#p' "${COMPOSE}")"
gate_test_record "an engine image tag is pinned" "$([ -n "${FLY_TAG}" ] && echo 0 || echo 1)"
assert_eq "fly.toml and compose.yaml pin the same hatchet-lite tag" "${FLY_TAG}" "${COMPOSE_TAG}"

gate_test_finish
