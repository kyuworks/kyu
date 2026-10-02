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

echo "[verify:gates] check-integration-shards"
bash scripts/gates/check-integration-shards.sh

echo "[verify:gates] check-no-escape-hatches"
bash scripts/gates/check-no-escape-hatches.sh

echo "[verify:gates] check-durable-wall-clock"
bash scripts/gates/check-durable-wall-clock.sh

echo "[verify:gates] check-package-boundaries"
bash scripts/gates/check-package-boundaries.sh

echo "[verify:gates] check-package-versions"
bash scripts/gates/check-package-versions.sh

echo "[verify:gates] check-package-exports"
bash scripts/gates/check-package-exports.sh

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

echo "[verify:gates] check-tsconfig-references"
bash scripts/gates/check-tsconfig-references.sh

echo "[verify:gates] check-selftest-git-isolation"
bash scripts/gates/check-selftest-git-isolation.sh

echo "[verify:gates] check-no-pipe-to-grep-q"
bash scripts/gates/check-no-pipe-to-grep-q.sh

if [ -n "${PR_BODY_FILE:-}" ]; then
  echo "[verify:gates] check-agent-ship-loop"
  bash scripts/gates/check-agent-ship-loop.sh --body "${PR_BODY_FILE}" --author "${PR_AUTHOR:-}" --branch "${PR_BRANCH:-}"
else
  echo "[verify:gates] check-agent-ship-loop skipped: PR_BODY_FILE is not set (set PR_BODY_FILE to check a pull request body)"
fi

echo "[verify:gates] OK"
