#!/usr/bin/env bash
# Unit tests for check-oidc-jobs-skip-cache.sh.
# Run: bash scripts/gates/check-oidc-jobs-skip-cache.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${ROOT_DIR}/scripts/lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-oidc-jobs-skip-cache.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
WF_DIR="${TMP}/workflows"
ACT_DIR="${TMP}/actions"

run_check() {
  CI_WORKFLOWS_DIR="${WF_DIR}" CI_ACTIONS_DIR="${ACT_DIR}" bash "${CHECK}"
}

run_real() {
  CI_WORKFLOWS_DIR="${ROOT_DIR}/.github/workflows" CI_ACTIONS_DIR="${ROOT_DIR}/.github/actions" bash "${CHECK}"
}

# publish_workflow <job-level lines> <setup with: lines>
publish_workflow() {
  rm -rf "${WF_DIR}"
  mkdir -p "${WF_DIR}"
  {
    printf 'name: Release\non:\n  push:\n    tags: [%sv*%s]\npermissions:\n  contents: read\njobs:\n  publish:\n    name: Publish packages\n    runs-on: ubuntu-latest\n' "'" "'"
    printf '%s' "$1"
    printf '    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - uses: actions/checkout@v5\n      - uses: ./.github/actions/setup\n        with:\n          build: %strue%s\n' "'" "'"
    printf '%s' "$2"
    printf '      - name: Publish\n        run: pnpm -r publish\n'
  } > "${WF_DIR}/release.yml"
}

NONE=$'    cache-mode: none\n'
NO_CACHE=$'          cache: \'false\'\n'

echo "=== check-oidc-jobs-skip-cache tests ==="

publish_workflow "${NONE}" ""
assert_exit "id-token job using the setup action without cache: 'false' is rejected" 1 run_check
assert_last_output_contains "the setup step is named" "uses ./.github/actions/setup without cache: 'false'"

publish_workflow "${NONE}" "${NO_CACHE}"
assert_exit "id-token job with cache-mode: none and cache: 'false' is accepted" 0 run_check
assert_last_output_contains "the job is listed as checked" "release.yml publish"

publish_workflow "    cache-mode: 'none'"$'\n' '          cache: "false"'$'\n'
assert_exit "quoted cache-mode and cache values are accepted" 0 run_check

publish_workflow "" "${NO_CACHE}"
assert_exit "id-token job without cache-mode: none is rejected" 1 run_check
assert_last_output_contains "the missing cache-mode is named" "does not set cache-mode: none"

publish_workflow "    cache-mode: read"$'\n' "${NO_CACHE}"
assert_exit "id-token job with cache-mode: read is rejected" 1 run_check

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
      - uses: actions/cache/restore@v4
        with:
          path: node_modules
          key: nm
YAML
assert_exit "id-token job calling actions/cache directly is rejected" 1 run_check
assert_last_output_contains "the direct cache step is named" "uses actions/cache directly"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"
cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test-unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/setup
      - uses: actions/cache@v4
        with:
          path: x
          key: x
YAML
assert_exit "a job without id-token that uses the cache is accepted" 0 run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
permissions:
  contents: read
  id-token: write
jobs:
  inherits:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/setup
  overrides:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: ./.github/actions/setup
YAML
assert_exit "a workflow-level id-token: write reaches a job with no permissions of its own" 1 run_check
assert_last_output_contains "the inheriting job is named" "ci.yml job inherits has id-token: write"
assert_output_lacks "a job that sets its own permissions without id-token is not checked" "ci.yml overrides" run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
jobs:
  everything:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - run: echo hi
YAML
assert_exit "permissions: write-all counts as id-token: write" 1 run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Newest client
on: schedule
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          sed -i 's/^minimumReleaseAge: .*/minimumReleaseAge: 0/' pnpm-workspace.yaml
YAML
assert_exit "a workflow that changes minimumReleaseAge without top-level cache-mode: none is rejected" 1 run_check
printf 'cache-mode: none\n' >> "${WF_DIR}/ci.yml"
assert_exit "a workflow that changes minimumReleaseAge with top-level cache-mode: none is accepted" 0 run_check

# Layouts the old line scanner could not read are read now, so the violation itself is named.
UNREADABLE="job publish has id-token: write but does not set cache-mode: none"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: {id-token: write, contents: read}
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "a job-level flow-map permissions with id-token: write is rejected" 1 run_check
assert_last_output_contains "the unreadable flow map is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions: {id-token: write, contents: read}
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "a workflow-level flow-map permissions with id-token: write is rejected" 1 run_check
assert_last_output_contains "the unreadable workflow flow map is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
    publish:
        runs-on: ubuntu-latest
        permissions:
            id-token: write
        steps:
            - uses: actions/cache@v4
YAML
assert_exit "jobs indented four spaces with id-token: write are rejected" 1 run_check
assert_last_output_contains "the unreadable indentation is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions:
    id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "a four-space workflow-level permissions block with id-token: write is rejected" 1 run_check
assert_last_output_contains "the unreadable permissions block is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions:
  id-token: write
jobs:
  readable:
    runs-on: ubuntu-latest
    cache-mode: none
    steps:
      - run: echo hi
  odd:
    runs-on: ubuntu-latest
    permissions: {id-token: write}
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "one readable id-token job does not excuse an unreadable one" 1 run_check
assert_last_output_contains "the unreadable job is named" "ci.yml job odd has id-token: write"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token : write
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "id-token with a space before the colon at job level is still an OIDC job" 1 run_check
assert_last_output_contains "the spaced job-level grant is read" "ci.yml job publish has id-token: write"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions :
  id-token : write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "id-token with a space before the colon at workflow level is still an OIDC job" 1 run_check
assert_last_output_contains "the spaced workflow-level grant is read" "ci.yml job publish has id-token: write"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions:
  id-token: write
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo hi
YAML
assert_exit "workflow-level id-token where every job overrides permissions without it passes" 0 run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions:
  id-token: write
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo hi
  publish: {runs-on: ubuntu-latest, steps: [{uses: actions/cache@v4}]}
YAML
assert_exit "workflow-level id-token with a job the gate cannot read is still rejected" 1 run_check

# cache-mode inheritance: a top-level value applies unless the job overrides it.
cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
cache-mode: none
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
assert_exit "a top-level cache-mode: none covers an id-token job with no cache-mode of its own" 0 run_check
sed -i.bak 's/^    runs-on: ubuntu-latest$/    runs-on: ubuntu-latest\n    cache-mode: write/' "${WF_DIR}/ci.yml" && rm "${WF_DIR}/ci.yml.bak"
assert_exit "a job-level cache-mode: write overrides a top-level cache-mode: none and is rejected" 1 run_check

# Every spelling of relaxing the release-age rule needs a top-level cache-mode: none.
for lift in \
  'run: PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install' \
  'run: pnpm_config_minimum_release_age=0 pnpm install' \
  'run: pnpm install --config.minimum-release-age=0'; do
  cat > "${WF_DIR}/ci.yml" <<YAML
name: Newest client
on: schedule
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - ${lift}
YAML
  assert_exit "'${lift#run: }' without top-level cache-mode: none is rejected" 1 run_check
  printf 'cache-mode: none\n' >> "${WF_DIR}/ci.yml"
  assert_exit "'${lift#run: }' with top-level cache-mode: none is accepted" 0 run_check
done

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
# minimumReleaseAge stays at seven days; this workflow does not change it.
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
assert_exit "a column-zero comment that mentions minimumReleaseAge is not a change to the rule" 0 run_check

publish_workflow "${NONE}" $'          cache: ${{ false }}\n'
assert_exit "cache: \${{ false }} is rejected (only the literal 'false' counts)" 1 run_check

# YAML anchors and aliases are resolved; merge keys, tags and aliases with no anchor fail closed.
GRANTED="job publish has id-token: write"
NOANCHOR="with no anchor before it"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
x-w: &w write
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: *w
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "an id-token value written as an alias is rejected" 1 run_check
assert_last_output_contains "the aliased id-token is named" "${GRANTED}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
x-a: &a write-all
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: *a
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "a permissions value written as an alias is rejected" 1 run_check
assert_last_output_contains "the aliased permissions is named" "${GRANTED}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
x-m: &m write
cache-mode: *m
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
assert_exit "a top-level cache-mode alias in a workflow that cannot publish is accepted" 0 run_check
assert_last_output_contains "nothing is checked there" "(none)"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    permissions: &p
      contents: read
    steps:
      - run: echo hi
  b:
    runs-on: ubuntu-latest
    permissions:
      <<: *p
    steps:
      - run: echo hi
YAML
assert_exit "an anchored permissions block, and a merge key inside one, are rejected" 1 run_check
assert_last_output_contains "the merge key inside permissions is named" "line 13 uses a YAML merge key"
assert_output_lacks "the anchor itself is not a failure" "line 6" run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      *p
    steps:
      - run: echo hi
YAML
assert_exit "a permissions alias on the line below the key is rejected" 1 run_check
assert_last_output_contains "the next-line alias is named" "line 7 uses alias *p ${NOANCHOR}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
x-p: &p
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    permissions: *p
    steps:
      - run: echo hi
YAML
assert_exit "a permissions alias that resolves to contents: read is accepted" 0 run_check
assert_last_output_contains "the aliased read grant is not checked" "(none)"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: !!str write
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "an id-token value with a YAML tag is rejected" 1 run_check
assert_last_output_contains "the tagged id-token is named" "line 7 has a YAML tag"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
  publish: {runs-on: ubuntu-latest, permissions: *a, steps: [{uses: actions/cache@v4}]}
YAML
assert_exit "a permissions alias inside a flow-map job is rejected" 1 run_check
assert_last_output_contains "the flow-map alias is named" "line 4 uses alias *a ${NOANCHOR}"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps: *shared
YAML
assert_exit "a publishing workflow with steps: *shared is rejected" 1 run_check
assert_last_output_contains "the shared steps are named" "line 25 uses alias *shared ${NOANCHOR}"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    <<: *base
    runs-on: ubuntu-latest
YAML
assert_exit "a publishing workflow with a <<: *base job is rejected" 1 run_check
assert_last_output_contains "the merge key is named" "line 24 uses a YAML merge key"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps: [*s]
YAML
assert_exit "a publishing workflow with an alias inside a flow sequence is rejected" 1 run_check
assert_last_output_contains "the flow-sequence alias is named" "line 25 uses alias *s ${NOANCHOR}"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps:
      - *step
YAML
assert_exit "a publishing workflow with an alias as a sequence item is rejected" 1 run_check
assert_last_output_contains "the sequence alias is named" "line 26 uses alias *step ${NOANCHOR}"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    <<: {runs-on: ubuntu-latest}
YAML
assert_exit "a publishing workflow with a merge key and no alias is rejected" 1 run_check
assert_last_output_contains "the bare merge key is named" "line 24 uses a YAML merge key"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo hi
    env: *e
YAML
assert_exit "an alias after a block scalar ends is still seen" 1 run_check
assert_last_output_contains "the alias after the block scalar is named" "line 28 uses alias *e ${NOANCHOR}"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo hi
  third:
    steps: *shared
YAML
assert_exit "shared steps in a job after a block scalar are still seen" 1 run_check
assert_last_output_contains "the shared steps after the block scalar are named" "line 29 uses alias *shared ${NOANCHOR}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      [*p]
    steps:
      - run: echo hi
YAML
assert_exit "a permissions alias inside a flow value on the line below the key is rejected" 1 run_check
assert_last_output_contains "the flow value alias is named" "line 7 uses alias *p ${NOANCHOR}"

# A quote opens only where a value starts, so an apostrophe or an escaped quote hides nothing.
publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps: [{name: Don't skip, run: echo}, *s, {name: 'x', run: echo}]
YAML
assert_exit "an apostrophe in a plain value does not hide a later alias" 1 run_check
assert_last_output_contains "the alias after the apostrophe is named" "line 25 uses alias *s ${NOANCHOR}"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps: ["a \" b", *s, "c"]
YAML
assert_exit "an escaped quote in a double-quoted value does not hide a later alias" 1 run_check
assert_last_output_contains "the alias after the escaped quote is named" "line 25 uses alias *s ${NOANCHOR}"

# Grants in any YAML spelling are read; a value that is not a plain grant fails closed.
UNREAD="cannot read the value of permissions, id-token or cache-mode"
READ="release.yml job publish has id-token: write"

# grant_workflow <job lines after runs-on>: a job that calls actions/cache directly.
grant_workflow() {
  rm -rf "${WF_DIR}"
  mkdir -p "${WF_DIR}"
  {
    printf 'name: Release\non: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n'
    printf '%s' "$1"
    printf '    steps:\n      - uses: actions/cache@v4\n'
  } > "${WF_DIR}/release.yml"
}

grant_workflow $'    permissions:\n      ? id-token\n      : write\n'
assert_exit "an explicit-key id-token grant is rejected" 1 run_check
assert_last_output_contains "the explicit key is read as a grant" "${READ}"

grant_workflow $'    permissions:\n      id-token:\n        write\n'
assert_exit "an id-token value on the next line is rejected" 1 run_check
assert_last_output_contains "the next-line id-token is read as a grant" "${READ}"

grant_workflow $'    permissions:\n      id-token: >-\n        write\n'
assert_exit "an id-token folded block scalar is rejected" 1 run_check
assert_last_output_contains "the folded id-token is read as a grant" "${READ}"

grant_workflow $'    permissions:\n      id-token: |\n        write\n'
assert_exit "an id-token literal block scalar is rejected" 1 run_check
assert_last_output_contains "the literal id-token (write plus a newline) is named" "line 7 ${UNREAD}"

grant_workflow $'    permissions:\n      write-all\n'
assert_exit "a permissions value on the next line is rejected" 1 run_check
assert_last_output_contains "the next-line permissions value is read as a grant" "${READ}"

grant_workflow $'    permissions: >\n      write-all\n'
assert_exit "a permissions block scalar is rejected" 1 run_check
assert_last_output_contains "the permissions block scalar is named" "line 6 ${UNREAD}"

grant_workflow $'    cache-mode:\n      none\n'
assert_exit "a cache-mode value on the next line in a job that cannot publish is accepted" 0 run_check
assert_last_output_contains "the next-line cache-mode job is not checked" "(none)"

grant_workflow $'    permissions:\n    env:\n      A: b\n'
assert_exit "an empty permissions value followed by a sibling key is accepted" 0 run_check

# A flow collection that spans lines, and an escaped value, are read like any other.

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps: [{run: echo,
      name: x}, *s]
YAML
assert_exit "a publishing workflow with a flow sequence that spans lines is rejected" 1 run_check
assert_last_output_contains "the alias in the spanning flow sequence is named" "line 26 uses alias *s ${NOANCHOR}"

grant_workflow $'    permissions: {contents: read, id-token:\n      write}\n'
assert_exit "a permissions flow map that spans lines is rejected" 1 run_check
assert_last_output_contains "the spanning permissions map is read as a grant" "${READ}"

grant_workflow $'    permissions:\n      {contents: read,\n       id-token: write}\n'
assert_exit "a flow map below the permissions key that spans lines is rejected" 1 run_check
assert_last_output_contains "the spanning map below the key is read as a grant" "${READ}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on:
  push:
    branches: [
      main,
      'release/*'
    ]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
rm -f "${WF_DIR}/release.yml"
assert_exit "a flow sequence that spans lines on an unguarded key, with no publishing job, is accepted" 0 run_check

# An escaped double-quoted value on a guarded key is not read.
grant_workflow $'    permissions:\n      id-token: "\\x77rite"\n'
assert_exit "an escaped id-token value is rejected" 1 run_check
assert_last_output_contains "the escaped id-token is read as a grant" "${READ}"

grant_workflow $'    cache-mode: "n\\x6fne"\n'
assert_exit "an escaped cache-mode value in a job that cannot publish is accepted" 0 run_check
assert_last_output_contains "the escaped cache-mode job is not checked" "(none)"

grant_workflow $'    permissions:\n      contents: "re\\x61d"\n'
assert_exit "an escaped contents: read inside a permissions block is accepted" 0 run_check
assert_last_output_contains "the escaped read grant is not checked" "(none)"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"
cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  one:
    runs-on: ubuntu-latest
    services: &engine
      postgres:
        image: postgres:15.6
        options: >-
          --health-cmd "pg_isready"
          --health-retries 10
    steps: &shared
      - uses: actions/checkout@v5
      - uses: ./.github/actions/setup
      - run: |
          for i in $(seq 1 3); do curl -fsS x && break; done
  two:
    runs-on: ubuntu-latest
    services: *engine
    steps: *shared
YAML
assert_exit "a workflow with no publishing job may share services and steps through anchors" 0 run_check

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  lookalikes:
    runs-on: ubuntu-latest
    if: ${{ github.event_name == 'push' && true }}
    env:
      CRON: '41 6 * * 1'
      GLOB: "*.ts"
    # sets key: *name
    steps:
      - run: pnpm lint && pnpm test
      - run: ls *.ts
      - run: 'echo flow: [a,*b]'
      - run: "echo \"key: *value\""
      - uses: some/action@v1
        with: {a: b}
        env:
          BRANCHES: [main, 'release/*']
          EXPR: ${{ matrix.x }}
      - run: |
          [[ -f x ]] && echo '{"a": [1,'
          { echo hi
      - name: Don't skip this
        run: echo done # see key: *name
      - run: |
          make a \
            && make b
          *unusual line in a script
          &another
      - name: Branches
        run: echo done
        env:
          B: ['*', 'a,*b']
YAML
assert_exit "text that only looks like an alias does not trip a publishing workflow" 0 run_check

# Escaped keys decode to the key GitHub reads, so they are grants.
grant_workflow $'    permissions:\n      "id\\x2dtoken": write\n'
assert_exit "an escaped id-token key is read as a grant" 1 run_check
assert_last_output_contains "the escaped id-token key is named" "${READ}"

grant_workflow $'    "perm\\x69ssions": write-all\n'
assert_exit "an escaped permissions key with write-all is read as a grant" 1 run_check
assert_last_output_contains "the escaped permissions key is named" "${READ}"

grant_workflow $'    permissions: {"id\\x2dtoken": write}\n'
assert_exit "an escaped id-token key in a flow map is read as a grant" 1 run_check
assert_last_output_contains "the escaped flow-map key is named" "${READ}"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"
cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest # id-token: "\x77rite"
    cache-mode: read # permissions: "wr\x69te-all"
    steps:
      - run: echo hi # cache-mode: "n\x6fne"
YAML
assert_exit "a comment that mentions an escaped value does not trip the gate" 0 run_check

# Constructs where the parser and GitHub could disagree fail closed, by name.
write_ci() {
  rm -rf "${WF_DIR}"
  mkdir -p "${WF_DIR}"
  cat > "${WF_DIR}/ci.yml"
}

printf 'name: CI\non: push\njobs: [unclosed\n' | write_ci
assert_exit "a file that does not parse is rejected" 1 run_check
assert_last_output_contains "the parse error is named" "ci.yml line 4 does not parse"

publish_workflow "${NONE}" "${NO_CACHE}"
printf -- '---\nname: Second\n' >> "${WF_DIR}/release.yml"
assert_exit "a file with two YAML documents is rejected" 1 run_check
assert_last_output_contains "the second document is named" "release.yml holds 2 YAML documents"

printf '# nothing here\n' | write_ci
assert_exit "a file with no YAML document is rejected" 1 run_check
assert_last_output_contains "the empty file is named" "ci.yml holds no YAML document"

grant_workflow $'    permissions:\n      contents: read\n    permissions: write-all\n'
assert_exit "a job with two permissions keys is rejected" 1 run_check
assert_last_output_contains "the duplicate key is named" "line 8 does not parse: Map keys must be unique"

grant_workflow $'    permissions:\n      id-token: read\n      "id\\x2dtoken": write\n'
assert_exit "an escaped spelling of a key already in the map is a duplicate" 1 run_check
assert_last_output_contains "the escaped duplicate is named" "line 8 does not parse: Map keys must be unique"

grant_workflow $'    permissions:\n      [id-token]: write\n'
assert_exit "a collection used as a key is rejected" 1 run_check
assert_last_output_contains "the collection key is named" "line 7 has a key that is not a plain string"

grant_workflow $'    true: write\n    permissions: read-all\n'
assert_exit "a boolean key is rejected" 1 run_check
assert_last_output_contains "the boolean key is named" "line 6 has a key that is not a plain string"

grant_workflow $'    env:\n      K: &k id-token\n    permissions:\n      *k : write\n'
assert_exit "an alias used as a key is rejected" 1 run_check
assert_last_output_contains "the alias key is named" "line 9 has a key that is not a plain string"

printf 'name: !!str CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' | write_ci
assert_exit "a YAML tag anywhere in a workflow is rejected" 1 run_check
assert_last_output_contains "the tag is named" "ci.yml line 1 has a YAML tag (tag:yaml.org,2002:str)"

publish_workflow "${NONE}" "${NO_CACHE}"
printf '  other:\n    "<<": {runs-on: ubuntu-latest}\n' >> "${WF_DIR}/release.yml"
assert_exit "a quoted merge key is rejected" 1 run_check
assert_last_output_contains "the quoted merge key is named" "line 24 uses a YAML merge key"

printf '%%YAML 1.1\n---\nname: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' | write_ci
assert_exit "a %YAML directive is rejected" 1 run_check
assert_last_output_contains "the directive is named" "ci.yml uses a %YAML or %TAG directive"

write_ci <<'YAML'
name: CI
on: push
env:
  A: &a [x, x, x, x, x, x, x, x, x, x]
  B: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
  C: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
  D: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
assert_exit "aliases that expand past the bound are rejected" 1 run_check
assert_last_output_contains "the alias bomb is named" "ci.yml cannot resolve its YAML aliases: Excessive alias count"

write_ci <<'YAML'
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps: &s
      - run: echo hi
      - *s
YAML
assert_exit "an alias inside its own anchor is rejected" 1 run_check
assert_last_output_contains "the recursive alias is named" "line 8 uses alias *s inside its own anchor"

printf -- '- name: CI\n' | write_ci
assert_exit "a workflow whose top level is not a map is rejected" 1 run_check
assert_last_output_contains "the top level is named" "ci.yml line 1 is not a YAML map at the top level"

printf 'name: CI\non: push\npermissions: write-all\njobs: [publish]\n' | write_ci
assert_exit "jobs that are not a map are rejected" 1 run_check
assert_last_output_contains "the jobs value is named" "ci.yml line 4 cannot read jobs"

printf 'name: CI\non: push\npermissions: write-all\njobs:\n  publish: run\n' | write_ci
assert_exit "a job that is not a map is rejected" 1 run_check
assert_last_output_contains "the job value is named" "ci.yml line 5 cannot read job publish"

printf 'name: CI\non: push\npermissions: write-all\ncache-mode: none\njobs:\n  publish:\n    steps: echo\n' | write_ci
assert_exit "steps that are not a list in a publishing job are rejected" 1 run_check
assert_last_output_contains "the steps value is named" "ci.yml line 7 cannot read the steps of job publish"

printf 'name: CI\non: push\npermissions: write-all\ncache-mode: none\njobs:\n  publish:\n    steps:\n      - echo hi\n' | write_ci
assert_exit "a step that is not a map in a publishing job is rejected" 1 run_check
assert_last_output_contains "the step value is named" "ci.yml line 8 cannot read a step of job publish"

printf 'name: CI\non: push\npermissions: write-all\ncache-mode: none\njobs:\n  publish:\n    steps:\n      - uses: [actions/cache@v4]\n' | write_ci
assert_exit "a uses value that is not a string is rejected" 1 run_check
assert_last_output_contains "the uses value is named" "ci.yml line 8 cannot read a step of job publish"

publish_workflow "${NONE}" "          cache: 'false'"$'\n'
sed -i.bak "s/^        with:$/        with: cache-false/; /^          build: 'true'$/d; /^          cache: 'false'$/d" "${WF_DIR}/release.yml" && rm "${WF_DIR}/release.yml.bak"
assert_exit "setup inputs that are not a map are rejected" 1 run_check
assert_last_output_contains "the inputs value is named" "cannot read the inputs of a step of job publish"

grant_workflow $'    cache-mode: none\n    permissions: write-all\n    uses: ./.github/workflows/publish.yml\n'
assert_exit "a publishing job that calls a reusable workflow is rejected" 1 run_check
assert_last_output_contains "the reusable workflow call is named" "job publish has id-token: write and calls a reusable workflow"

grant_workflow $'    permissions: write\n'
assert_exit "a permissions shorthand GitHub does not define is rejected" 1 run_check
assert_last_output_contains "the unknown shorthand is named" "line 6 ${UNREAD}"

grant_workflow $'    permissions:\n      id-token: Write\n'
assert_exit "an id-token level GitHub does not define is rejected" 1 run_check
assert_last_output_contains "the unknown level is named" "line 7 ${UNREAD}"

grant_workflow $'    Permissions:\n      ID-Token: write\n'
assert_exit "keys in another letter case are read as a grant" 1 run_check
assert_last_output_contains "the mixed-case grant is named" "${READ}"

grant_workflow $'    permissions:\n      contents: read\n    Permissions: write-all\n'
assert_exit "two keys that differ only in letter case are rejected" 1 run_check
assert_last_output_contains "the case duplicate is named" "line 8 repeats a key in another letter case"

# Aliases are resolved, so a shared step or value is checked where it is used.
write_ci <<'YAML'
name: Release
on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps: &steps
      - uses: actions/cache@v4
  publish:
    runs-on: ubuntu-latest
    cache-mode: none
    permissions:
      id-token: write
    steps: *steps
YAML
assert_exit "a cache step brought into a publishing job by an alias is rejected" 1 run_check
assert_last_output_contains "the aliased cache step is named" "ci.yml job publish uses actions/cache directly"
assert_output_lacks "the job that only defines the anchor is not checked" "ci.yml build" run_check

write_ci <<'YAML'
name: Release
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    cache-mode: &none none
    steps:
      - &restore {uses: Actions/Cache/Restore@v4}
  publish:
    runs-on: ubuntu-latest
    cache-mode: *none
    permissions:
      id-token: write
    steps:
      - *restore
YAML
assert_exit "an aliased step with a mixed-case cache action is rejected" 1 run_check
assert_last_output_contains "the aliased restore step is named" "ci.yml job publish uses actions/cache directly"
assert_output_lacks "the aliased cache-mode: none is read" "does not set cache-mode" run_check

write_ci <<'YAML'
name: Release
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    cache-mode: &none none
    steps:
      - &setup
        uses: ./.github/actions/setup
        with:
          cache: false
  publish:
    runs-on: ubuntu-latest
    cache-mode: *none
    permissions: &grant
      id-token: write
    steps:
      - *setup
YAML
assert_exit "a compliant publishing job written with aliases is accepted" 0 run_check
assert_last_output_contains "the aliased job is checked" "ci.yml publish"

publish_workflow "${NONE}" $'          cache: FALSE\n'
assert_exit "cache: FALSE is rejected (only the text false counts)" 1 run_check

publish_workflow "${NONE}" $'          cache: "f\\x61lse"\n'
assert_exit "an escaped cache: false is read as false" 0 run_check

publish_workflow "${NONE}" "${NO_CACHE}"
sed -i.bak 's#uses: ./.github/actions/setup$#uses: ./.github/actions/../actions/setup#' "${WF_DIR}/release.yml" && rm "${WF_DIR}/release.yml.bak"
sed -i.bak "/^          cache: 'false'$/d" "${WF_DIR}/release.yml" && rm "${WF_DIR}/release.yml.bak"
assert_exit "a setup path with .. in it is still the setup action" 1 run_check
assert_last_output_contains "the dotted setup path is named" "uses ./.github/actions/setup without cache: 'false'"

# The release-age rule reads every string after escapes are decoded.
for lift in \
  'run: "PNPM_CONFIG_MINIMUM_RELEASE_\x41GE=0 pnpm install"' \
  'env: {npm_config_minimum_release_age: 0}'; do
  write_ci <<YAML
name: Newest client
on: schedule
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - ${lift}
YAML
  assert_exit "'${lift}' without top-level cache-mode: none is rejected" 1 run_check
  printf 'cache-mode: none\n' >> "${WF_DIR}/ci.yml"
  assert_exit "'${lift}' with top-level cache-mode: none is accepted" 0 run_check
done

# Action files are read with the same rules.
write_ci <<'YAML'
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
mkdir -p "${ACT_DIR}/broken"
printf 'name: Broken\nruns: [unclosed\n' > "${ACT_DIR}/broken/action.yml"
assert_exit "an action file that does not parse is rejected" 1 run_check
assert_last_output_contains "the broken action is named" "actions/broken/action.yml line 3 does not parse"
rm -rf "${ACT_DIR}"

mkdir -p "${ACT_DIR}/young"
cat > "${ACT_DIR}/young/action.yml" <<'YAML'
name: Young
runs:
  using: composite
  steps:
    - shell: bash
      run: pnpm install --config.minimum-release-age=0
YAML
assert_exit "an action that relaxes the release-age rule is rejected" 1 run_check
assert_last_output_contains "the relaxing action is named" "actions/young/action.yml relaxes the release-age rule"
rm -rf "${ACT_DIR}"

run_broken_reader() {
  CI_WORKFLOWS_DIR="${WF_DIR}" CI_ACTIONS_DIR="${WF_DIR}/ci.yml" bash "${CHECK}"
}
assert_exit "a reader that stops partway fails the gate" 1 run_broken_reader
assert_last_output_contains "the stopped reader is named" "the workflow reader stopped"

assert_exit "the repository's workflows pass" 0 run_real
assert_last_output_contains "the release job is checked" "release.yml publish"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"
grep -v 'cache-mode: none' "${ROOT_DIR}/.github/workflows/release.yml" > "${WF_DIR}/release.yml"
assert_exit "the real release.yml without cache-mode: none is rejected" 1 run_check
grep -v "cache: 'false'" "${ROOT_DIR}/.github/workflows/release.yml" > "${WF_DIR}/release.yml"
assert_exit "the real release.yml without cache: 'false' is rejected" 1 run_check

gate_test_finish
