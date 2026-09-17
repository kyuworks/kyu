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
printf "import { y } from '@kinesin/a'\nexport const z = y\n" > "${WORK}/ok/packages/b/src/z.ts"
assert_exit "in-package relative and by-name imports pass" 0 env ROOT_DIR="${WORK}/ok" bash "${CHECK}"
mkdir -p "${WORK}/bad/packages/a/src" "${WORK}/bad/packages/b/src"
printf "export const x = 1\n" > "${WORK}/bad/packages/a/src/x.ts"
printf "import { x } from '../../a/src/x.js'\nexport const z = x\n" > "${WORK}/bad/packages/b/src/z.ts"
assert_exit "relative import into another package fails" 1 env ROOT_DIR="${WORK}/bad" bash "${CHECK}"
mkdir -p "${WORK}/deep/packages/b/src"
printf "import { x } from '@kinesin/a/src/x.js'\nexport const z = x\n" > "${WORK}/deep/packages/b/src/z.ts"
assert_exit "deep import past the exports map fails" 1 env ROOT_DIR="${WORK}/deep" bash "${CHECK}"

mkdir -p "${WORK}/example-ok/examples/playground/src"
printf "import { publish } from '@kinesin/sdk'\nexport const p = publish\n" > "${WORK}/example-ok/examples/playground/src/index.ts"
assert_exit "example importing @kinesin/sdk passes" 0 env ROOT_DIR="${WORK}/example-ok" bash "${CHECK}"

mkdir -p "${WORK}/example-hatchet/examples/playground/src"
printf "import { Hatchet } from '@hatchet-dev/typescript-sdk'\nexport const h = Hatchet\n" > "${WORK}/example-hatchet/examples/playground/src/index.ts"
assert_exit "example importing @hatchet-dev/ fails" 1 env ROOT_DIR="${WORK}/example-hatchet" bash "${CHECK}"
assert_output_contains "failure says examples consume @kinesin/sdk only" "@kinesin/sdk only" env ROOT_DIR="${WORK}/example-hatchet" bash "${CHECK}"

mkdir -p "${WORK}/example-schemas/examples/playground/src"
printf "import { parseEnvelope } from '@kinesin/schemas'\nexport const p = parseEnvelope\n" > "${WORK}/example-schemas/examples/playground/src/index.ts"
assert_exit "example importing @kinesin/schemas fails" 1 env ROOT_DIR="${WORK}/example-schemas" bash "${CHECK}"
assert_output_contains "failure says examples consume @kinesin/sdk only (schemas case)" "@kinesin/sdk only" env ROOT_DIR="${WORK}/example-schemas" bash "${CHECK}"

gate_test_finish
