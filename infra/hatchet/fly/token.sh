#!/usr/bin/env bash
# Print a worker API token for the deployed dev Hatchet engine.
#
#   export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/fly/token.sh -a <engine-app>)"
#
# The token is written only to stdout — never logged, never echoed anywhere
# else. Needs the Fly CLI and an SSH certificate for the org; the CTO runs
# `fly ssh issue` once before this script can reach the machine.
set -euo pipefail

APP="${KYU_FLY_APP:-}"
TENANT_ID="${KYU_HATCHET_TENANT_ID:-707d0855-80ab-4e1f-a156-f1c4546cbf52}"

usage() {
  cat <<'EOF' >&2
usage: token.sh -a|--app <name> [--tenant-id <uuid>]

  -a, --app <name>        Fly app name (default: $KYU_FLY_APP)
      --tenant-id <uuid>  Hatchet tenant id (default: $KYU_HATCHET_TENANT_ID
                          or the seeded default 707d0855-80ab-4e1f-a156-f1c4546cbf52)
  -h, --help              Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -a|--app)
      [ $# -ge 2 ] || { usage; exit 2; }
      APP="$2"
      shift 2
      ;;
    --tenant-id)
      [ $# -ge 2 ] || { usage; exit 2; }
      TENANT_ID="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ -z "${APP}" ]; then
  usage
  exit 2
fi

fly ssh console -a "${APP}" -C "/hatchet-admin token create --config /config --tenant-id ${TENANT_ID}" | tail -1 | tr -d '\r\n'
echo
