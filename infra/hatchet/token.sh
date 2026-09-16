#!/usr/bin/env bash
# Print a worker API token for the local Hatchet Lite stack's default tenant.
#
#   export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
#   export HATCHET_CLIENT_TLS_STRATEGY=none
#
# The default tenant id is the one hatchet-lite seeds on first boot.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TENANT_ID="${KINESIN_HATCHET_TENANT_ID:-707d0855-80ab-4e1f-a156-f1c4546cbf52}"
docker compose -f "${ROOT}/infra/hatchet/compose.yaml" exec -T hatchet-lite \
  /hatchet-admin token create --config /config --tenant-id "${TENANT_ID}" | tr -d '\r\n'
echo
