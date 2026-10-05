#!/usr/bin/env bash
# check-engine-image-tag.sh — the local stack, the Fly deployment and CI run the
# same hatchet-lite tag. The default in infra/hatchet/compose.yaml is the source
# of truth; it must be a pinned vMAJOR.MINOR.PATCH, never latest.
#
# The rules are in check-engine-image-tag.mjs, which reads compose.yaml and every
# YAML file under .github/ with the `yaml` package (workflow-yaml.mjs) and fails a
# file it cannot read. The rule list is at the top of that file. ci.yml,
# newest-client.yml and fly.toml must exist and each name the engine.
#
# Env overrides (for tests):
#   ROOT_DIR — repo root to read (default: repo root)
#
# Usage:
#   bash scripts/gates/check-engine-image-tag.sh
# Self-test: bash scripts/gates/check-engine-image-tag.test.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
source "${SCRIPT_DIR}/../lib/require-yaml.sh"
for arg in "$@"; do
  echo "FAIL: unknown argument: ${arg}" >&2
  exit 1
done
echo "=== Engine image tag ==="
require_yaml_package "${SCRIPT_DIR}"
exec node "${SCRIPT_DIR}/check-engine-image-tag.mjs" "${ROOT_DIR}"
