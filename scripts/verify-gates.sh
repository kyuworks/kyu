#!/usr/bin/env bash
# verify-gates.sh — architecture and process gates. Each gate is a small script
# under scripts/gates with a colocated *.test.sh. Add a gate when a review
# comment would otherwise be repeated.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
bash scripts/lib/check-node-engine.sh
echo "[verify:gates] === Architecture + security ==="

range_arg=""
prev=""
for arg in "$@"; do
  [ "${prev}" = "--range" ] && range_arg="${arg}"
  prev="${arg}"
done

echo "[verify:gates] check-required-ci-jobs"
bash scripts/gates/check-required-ci-jobs.sh

echo "[verify:gates] check-no-escape-hatches"
bash scripts/gates/check-no-escape-hatches.sh

echo "[verify:gates] check-package-boundaries"
bash scripts/gates/check-package-boundaries.sh

echo "[verify:gates] check-migration-no-transactions"
bash scripts/gates/check-migration-no-transactions.sh

echo "[verify:gates] check-migration-immutability"
if [ -n "${range_arg}" ]; then
  BASE_SHA="${range_arg%%...*}" bash scripts/gates/check-migration-immutability.sh
else
  bash scripts/gates/check-migration-immutability.sh
fi

echo "[verify:gates] check-pr-size"
if [ -n "${range_arg}" ]; then
  bash scripts/gates/check-pr-size.sh --range "${range_arg}"
else
  bash scripts/gates/check-pr-size.sh
fi

echo "[verify:gates] OK"
