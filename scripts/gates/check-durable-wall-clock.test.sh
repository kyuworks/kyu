#!/usr/bin/env bash
# Run: bash scripts/gates/check-durable-wall-clock.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-durable-wall-clock.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== check-durable-wall-clock tests ==="

mkdir -p "${WORK}/clean/examples/shop/src/handlers" "${WORK}/clean/examples/shop/src/__tests__" "${WORK}/clean/packages/sdk/src"
cat > "${WORK}/clean/examples/shop/src/handlers/durableOk.ts" <<'TS'
// Date.now() in a comment is not a read.
export const s = kyu.durable(d, {
  handler: async (ctx) => {
    const now = await ctx.now()
    return new Date(now.getTime() + 60_000)
  },
})
TS
printf 'export const s = kyu.subscribe(d, { handler: () => Date.now() })\n' > "${WORK}/clean/examples/shop/src/handlers/plain.ts"
printf 'export const s = kyu.durable(d, { handler: () => Date.now() })\n' > "${WORK}/clean/examples/shop/src/handlers/durableOk.test.ts"
printf 'export const s = kyu.durable(d, { handler: () => Date.now() })\n' > "${WORK}/clean/examples/shop/src/__tests__/harness.ts"
printf 'type C = DurableContext<X>\nexport const at = new DateTime()\n' > "${WORK}/clean/packages/sdk/src/wait.ts"
assert_exit "a durable file that reads ctx.now(), a subscribe file and tests pass" 0 \
  env ROOT_DIR="${WORK}/clean" bash "${CHECK}"

mkdir -p "${WORK}/date-now/examples/shop/src/handlers"
printf 'export const s = kyu.durable(d, {\n  handler: () => new Date(Date.now() + 1000),\n})\n' > "${WORK}/date-now/examples/shop/src/handlers/run.ts"
assert_exit "Date.now() in a durable handler file fails" 1 env ROOT_DIR="${WORK}/date-now" bash "${CHECK}"
assert_output_contains "failure names the file and line" "examples/shop/src/handlers/run.ts:2:" \
  env ROOT_DIR="${WORK}/date-now" bash "${CHECK}"

mkdir -p "${WORK}/new-date/examples/shop/src/handlers"
printf 'type T = DurableHandlerContext<X>\nfunction step(ctx: T) {\n  return new Date()\n}\n' > "${WORK}/new-date/examples/shop/src/handlers/step.ts"
assert_exit "argument-less new Date() in a file that takes DurableHandlerContext fails" 1 \
  env ROOT_DIR="${WORK}/new-date" bash "${CHECK}"

mkdir -p "${WORK}/bare-new/packages/sdk/src"
printf 'type C = DurableContext<X>\nconst at = new Date\n' > "${WORK}/bare-new/packages/sdk/src/wait.ts"
assert_exit "new Date without parentheses in an SDK durable file fails" 1 \
  env ROOT_DIR="${WORK}/bare-new" bash "${CHECK}"

gate_test_finish
