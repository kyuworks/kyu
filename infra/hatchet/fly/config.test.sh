#!/usr/bin/env bash
# Static checks on the engine template's fly.toml and the guide names that must match it. Run: bash infra/hatchet/fly/config.test.sh
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
# The app name and the deployment-specific values are secrets (infra/hatchet/fly/secrets.sh), not fly.toml.
assert_exit "fly.toml names no app" 1 grep -qE "^app[[:space:]]*=" "${FLY_TOML}"
assert_exit "fly.toml names no deployment host" 1 grep -qE "\.(fly\.dev|internal)" "${FLY_TOML}"
assert_exit "the company domain is not in fly.toml" 1 grep -qE "^[[:space:]]*SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS =" "${FLY_TOML}"
for name in SERVER_URL SERVER_AUTH_COOKIE_DOMAIN SERVER_GRPC_BROADCAST_ADDRESS; do
  assert_exit "${name} is a secret, not env" 1 grep -q "^  ${name} =" "${FLY_TOML}"
done

# Engine-wide: the engine drops whole daily partitions older than this (guide "Retention").
assert_exit "the template's retention is seven days" 0 \
  grep -qE "^[[:space:]]*SERVER_LIMITS_DEFAULT_TENANT_RETENTION_PERIOD = '168h'\$" "${FLY_TOML}"
COMPOSE_RETENTION="$(sed -nE "s#^[[:space:]]*SERVER_LIMITS_DEFAULT_TENANT_RETENTION_PERIOD: '([0-9a-z]+)'\$#\1#p" "${COMPOSE}")"
assert_eq "compose.yaml sets the same 168h retention as the template" "168h" "${COMPOSE_RETENTION}"

# Refuses every signup (form and OAuth starts) before the domain check even runs.
assert_exit "signup is off in the template" 0 \
  grep -qE "^[[:space:]]*SERVER_ALLOW_SIGNUP = 'f'\$" "${FLY_TOML}"

gate_test_finish
