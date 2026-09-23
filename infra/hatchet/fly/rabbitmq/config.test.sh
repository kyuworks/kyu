#!/usr/bin/env bash
# Static checks on fly.toml (#176). Run: bash infra/hatchet/fly/rabbitmq/config.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../../scripts/lib/gate-test-lib.sh"
FLY_TOML="${SCRIPT_DIR}/fly.toml"

echo "=== rabbitmq fly.toml self-tests ==="
assert_exit "fly.toml exists" 0 test -f "${FLY_TOML}"

assert_output_contains "app is <rabbitmq-app>" "app = '<rabbitmq-app>'" cat "${FLY_TOML}"
assert_output_contains "primary region is syd" "primary_region = 'syd'" cat "${FLY_TOML}"
assert_output_contains "mount destination is the rabbitmq data dir" "destination = '/var/lib/rabbitmq'" cat "${FLY_TOML}"
assert_output_contains "mount source is kyu_rabbitmq_data" "source = 'kyu_rabbitmq_data'" cat "${FLY_TOML}"
assert_output_contains "node name is fixed" "RABBITMQ_NODENAME = 'rabbit@localhost'" cat "${FLY_TOML}"
assert_output_contains "restart policy is always" "policy = 'always'" cat "${FLY_TOML}"
assert_output_contains "vm size is performance-1x" "size = 'performance-1x'" cat "${FLY_TOML}"
assert_output_contains "health check type is tcp" "type = 'tcp'" cat "${FLY_TOML}"
assert_output_contains "health check port is 5672" "port = 5672" cat "${FLY_TOML}"

assert_output_lacks "no [[services]] block" "[[services]]" cat "${FLY_TOML}"
assert_output_lacks "no [http_service] block" "[http_service]" cat "${FLY_TOML}"
assert_output_lacks "no RABBITMQ_DEFAULT_USER value" "RABBITMQ_DEFAULT_USER =" cat "${FLY_TOML}"
assert_output_lacks "no RABBITMQ_DEFAULT_PASS value" "RABBITMQ_DEFAULT_PASS =" cat "${FLY_TOML}"
assert_output_lacks "no amqp URL" "amqp://" cat "${FLY_TOML}"

assert_exit "image is rabbitmq pinned to an exact x.y.z tag" 0 \
  grep -Eq "^  image = 'rabbitmq:[0-9]+\.[0-9]+\.[0-9]+'\$" "${FLY_TOML}"

gate_test_finish
