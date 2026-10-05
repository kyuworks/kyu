#!/usr/bin/env bash
# Run: bash scripts/gates/check-package-boundaries.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-package-boundaries.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== check-package-boundaries tests ==="
mkdir -p "${WORK}/ok/packages/a/src/inner" "${WORK}/ok/packages/b/src"
printf "import { x } from '../x.js'\nexport const y = x\n" > "${WORK}/ok/packages/a/src/inner/y.ts"
printf "export const x = 1\n" > "${WORK}/ok/packages/a/src/x.ts"
printf "import { y } from '@kyuworks/a'\nexport const z = y\n" > "${WORK}/ok/packages/b/src/z.ts"
assert_exit "in-package relative and by-name imports pass" 0 env ROOT_DIR="${WORK}/ok" bash "${CHECK}"
mkdir -p "${WORK}/bad/packages/a/src" "${WORK}/bad/packages/b/src"
printf "export const x = 1\n" > "${WORK}/bad/packages/a/src/x.ts"
printf "import { x } from '../../a/src/x.js'\nexport const z = x\n" > "${WORK}/bad/packages/b/src/z.ts"
assert_exit "relative import into another package fails" 1 env ROOT_DIR="${WORK}/bad" bash "${CHECK}"
mkdir -p "${WORK}/deep/packages/b/src"
printf "import { x } from '@kyuworks/a/src/x.js'\nexport const z = x\n" > "${WORK}/deep/packages/b/src/z.ts"
assert_exit "deep import past the exports map fails" 1 env ROOT_DIR="${WORK}/deep" bash "${CHECK}"

mkdir -p "${WORK}/example-ok/examples/shop/src"
printf "import { publish } from '@kyuworks/sdk'\nexport const p = publish\n" > "${WORK}/example-ok/examples/shop/src/index.ts"
assert_exit "example importing @kyuworks/sdk passes" 0 env ROOT_DIR="${WORK}/example-ok" bash "${CHECK}"

mkdir -p "${WORK}/example-hatchet/examples/shop/src"
printf "import { Hatchet } from '@hatchet-dev/typescript-sdk'\nexport const h = Hatchet\n" > "${WORK}/example-hatchet/examples/shop/src/index.ts"
assert_exit "example importing @hatchet-dev/ fails" 1 env ROOT_DIR="${WORK}/example-hatchet" bash "${CHECK}"
assert_output_contains "failure says examples consume @kyuworks/sdk only" "@kyuworks/sdk only" env ROOT_DIR="${WORK}/example-hatchet" bash "${CHECK}"

mkdir -p "${WORK}/example-schemas/examples/shop/src"
printf "import { parseEnvelope } from '@kyuworks/schemas'\nexport const p = parseEnvelope\n" > "${WORK}/example-schemas/examples/shop/src/index.ts"
assert_exit "example importing @kyuworks/schemas fails" 1 env ROOT_DIR="${WORK}/example-schemas" bash "${CHECK}"
assert_output_contains "failure says examples consume @kyuworks/sdk only (schemas case)" "@kyuworks/sdk only" env ROOT_DIR="${WORK}/example-schemas" bash "${CHECK}"

# --- Every import form of a banned package is caught, not just `from` (#review) ---
mkdir -p "${WORK}/example-bare-import/examples/shop/src"
printf "import '@hatchet-dev/typescript-sdk'\nexport const p = 1\n" > "${WORK}/example-bare-import/examples/shop/src/index.ts"
assert_exit "bare side-effect import of @hatchet-dev/ fails" 1 env ROOT_DIR="${WORK}/example-bare-import" bash "${CHECK}"

mkdir -p "${WORK}/example-dynamic-import/examples/shop/src"
printf "export const h = await import('@hatchet-dev/typescript-sdk')\n" > "${WORK}/example-dynamic-import/examples/shop/src/index.ts"
assert_exit "dynamic import() of @hatchet-dev/ fails" 1 env ROOT_DIR="${WORK}/example-dynamic-import" bash "${CHECK}"

mkdir -p "${WORK}/example-require/examples/shop/src"
printf "const h = require('@hatchet-dev/typescript-sdk')\nexport { h }\n" > "${WORK}/example-require/examples/shop/src/index.ts"
assert_exit "require() of @hatchet-dev/ fails" 1 env ROOT_DIR="${WORK}/example-require" bash "${CHECK}"

mkdir -p "${WORK}/example-schemas-dynamic/examples/shop/src"
printf "export const s = await import('@kyuworks/schemas')\n" > "${WORK}/example-schemas-dynamic/examples/shop/src/index.ts"
assert_exit "dynamic import() of @kyuworks/schemas fails" 1 env ROOT_DIR="${WORK}/example-schemas-dynamic" bash "${CHECK}"

# --- The dependency itself in package.json fails too, not just the import (#review) ---
mkdir -p "${WORK}/example-pkg-dep/examples/shop/src"
printf "export const p = 1\n" > "${WORK}/example-pkg-dep/examples/shop/src/index.ts"
cat > "${WORK}/example-pkg-dep/examples/shop/package.json" <<'JSON'
{
  "name": "@kyuworks/example-shop",
  "dependencies": { "@hatchet-dev/typescript-sdk": "^1.0.0" }
}
JSON
assert_exit "@hatchet-dev/ in package.json dependencies fails" 1 env ROOT_DIR="${WORK}/example-pkg-dep" bash "${CHECK}"

mkdir -p "${WORK}/example-pkg-devdep/examples/shop/src"
printf "export const p = 1\n" > "${WORK}/example-pkg-devdep/examples/shop/src/index.ts"
cat > "${WORK}/example-pkg-devdep/examples/shop/package.json" <<'JSON'
{
  "name": "@kyuworks/example-shop",
  "devDependencies": { "@kyuworks/schemas": "workspace:*" }
}
JSON
assert_exit "@kyuworks/schemas in package.json devDependencies fails" 1 env ROOT_DIR="${WORK}/example-pkg-devdep" bash "${CHECK}"

mkdir -p "${WORK}/example-pkg-ok/examples/shop/src"
printf "import { publish } from '@kyuworks/sdk'\nexport const p = publish\n" > "${WORK}/example-pkg-ok/examples/shop/src/index.ts"
cat > "${WORK}/example-pkg-ok/examples/shop/package.json" <<'JSON'
{
  "name": "@kyuworks/example-shop",
  "dependencies": { "@kyuworks/sdk": "workspace:*" }
}
JSON
assert_exit "package.json depending on @kyuworks/sdk only passes" 0 env ROOT_DIR="${WORK}/example-pkg-ok" bash "${CHECK}"

# --- examples/*/src/**/*.test.ts is scanned too, unlike check-no-escape-hatches (#review asymmetry) ---
mkdir -p "${WORK}/example-test-file/examples/shop/src"
printf "import { Hatchet } from '@hatchet-dev/typescript-sdk'\nexport const h = Hatchet\n" > "${WORK}/example-test-file/examples/shop/src/index.test.ts"
assert_exit "a banned import in an example's own .test.ts still fails" 1 \
  env ROOT_DIR="${WORK}/example-test-file" bash "${CHECK}"

# --- A package-root file (vitest config/setup, not under src) is scanned too (#review) ---
mkdir -p "${WORK}/example-root-file/examples/shop/src"
printf "export const p = 1\n" > "${WORK}/example-root-file/examples/shop/src/index.ts"
printf "import { Hatchet } from '@hatchet-dev/typescript-sdk'\nexport const h = Hatchet\n" > "${WORK}/example-root-file/examples/shop/vitest.integration.setup.ts"
assert_exit "a banned import in an example's package-root file fails" 1 \
  env ROOT_DIR="${WORK}/example-root-file" bash "${CHECK}"

# --- Inside packages/sdk only src/hatchet.ts imports the engine client (#38) ---
sdk_case() {
  local name="$1" rel="$2" body="$3"
  mkdir -p "$(dirname "${WORK}/${name}/packages/sdk/${rel}")"
  printf '%b' "${body}" > "${WORK}/${name}/packages/sdk/${rel}"
}
sdk_case sdk-from src/consume/worker.ts "import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'\nexport const h = HatchetClient\n"
assert_exit "sdk file other than hatchet.ts importing the client with from fails" 1 env ROOT_DIR="${WORK}/sdk-from" bash "${CHECK}"
assert_last_output_contains "sdk failure names the file and line" "packages/sdk/src/consume/worker.ts:1:"
assert_last_output_contains "sdk failure points at src/hatchet.ts" "src/hatchet.ts only"
sdk_case sdk-type src/consume/types.ts "import type { Context } from '@hatchet-dev/typescript-sdk/v1/index.js'\nexport type C = Context\n"
assert_exit "sdk type-only import of the client fails" 1 env ROOT_DIR="${WORK}/sdk-type" bash "${CHECK}"
sdk_case sdk-reexport src/index.ts "export * from '@hatchet-dev/typescript-sdk'\n"
assert_exit "sdk re-export of the client fails" 1 env ROOT_DIR="${WORK}/sdk-reexport" bash "${CHECK}"
sdk_case sdk-bare src/consume/worker.ts "import '@hatchet-dev/typescript-sdk'\nexport const p = 1\n"
assert_exit "sdk bare side-effect import of the client fails" 1 env ROOT_DIR="${WORK}/sdk-bare" bash "${CHECK}"
sdk_case sdk-dynamic src/consume/worker.ts "export const h = await import('@hatchet-dev/typescript-sdk/v1/index.js')\n"
assert_exit "sdk dynamic import() of the client fails" 1 env ROOT_DIR="${WORK}/sdk-dynamic" bash "${CHECK}"
sdk_case sdk-require src/consume/worker.ts "const h = require('@hatchet-dev/typescript-sdk')\nexport { h }\n"
assert_exit "sdk require() of the client fails" 1 env ROOT_DIR="${WORK}/sdk-require" bash "${CHECK}"
sdk_case sdk-other-test src/consume/worker.test.ts "import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'\nexport const h = HatchetClient\n"
assert_exit "sdk test file other than hatchet.test.ts importing the client fails" 1 env ROOT_DIR="${WORK}/sdk-other-test" bash "${CHECK}"
sdk_case sdk-root-file vitest.integration.setup.ts "import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'\nexport const h = HatchetClient\n"
assert_exit "sdk package-root file importing the client fails" 1 env ROOT_DIR="${WORK}/sdk-root-file" bash "${CHECK}"
sdk_case sdk-nested-name src/consume/hatchet.ts "import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'\nexport const h = HatchetClient\n"
assert_exit "sdk file named hatchet.ts outside src/ root fails" 1 env ROOT_DIR="${WORK}/sdk-nested-name" bash "${CHECK}"
sdk_case sdk-allowed src/hatchet.ts "import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'\nexport const h = await import('@hatchet-dev/typescript-sdk')\nexport { HatchetClient }\n"
sdk_case sdk-allowed src/hatchet.test.ts "import { ClientConfigSchema } from '@hatchet-dev/typescript-sdk/clients/hatchet-client/client-config.js'\nexport const c = ClientConfigSchema\n"
sdk_case sdk-allowed src/consume/worker.ts "import { HatchetClient } from '../hatchet.js'\nexport const h = HatchetClient\n"
sdk_case sdk-allowed dist/consume/worker.d.ts "import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'\nexport declare const h: HatchetClient\n"
assert_exit "sdk src/hatchet.ts, its test and built dist output pass" 0 env ROOT_DIR="${WORK}/sdk-allowed" bash "${CHECK}"
sdk_case sdk-mention src/consume/worker.ts "// Wraps @hatchet-dev/typescript-sdk through ../hatchet.js.\nexport const engine = '@hatchet-dev/typescript-sdk'\n"
assert_exit "sdk comment or string naming the client passes" 0 env ROOT_DIR="${WORK}/sdk-mention" bash "${CHECK}"

gate_test_finish
