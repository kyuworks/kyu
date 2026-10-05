#!/usr/bin/env bash
# Unit tests for check-required-ci-jobs.sh (#282, #55).
# Run: bash scripts/gates/check-required-ci-jobs.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-required-ci-jobs.sh"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

WF_DIR="${TMP}/workflows"
WF="${WF_DIR}/ci.yml"
REQ="${TMP}/required-checks.txt"

run_check() {
  CI_WORKFLOWS_DIR="${WF_DIR}" REQUIRED_CHECKS="${REQ}" bash "${CHECK}"
}

write_workflow() {
  rm -rf "${WF_DIR}"
  mkdir -p "${WF_DIR}"
  cat > "${WF}" <<'YAML'
name: CI

on:
  pull_request:

jobs:
  migration-check:
    name: Migration Check
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v5
      - name: Check timestamps
        run: echo ok

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v5
YAML
}

write_required() {
  cat > "${REQ}" <<'TXT'
Migration Check
Type Check
TXT
}

# write_second_workflow file on-block job-name
write_second_workflow() {
  printf 'name: Second\n\n%s\n\njobs:\n  second:\n    name: %s\n    runs-on: ubuntu-latest\n' \
    "$2" "$3" > "${WF_DIR}/$1"
}

echo "=== check-required-ci-jobs tests ==="

# --- Matching fixture lists ---
write_workflow
write_required
assert_exit "matching fixture lists are accepted" 0 run_check
assert_output_contains "matching lists print success" "Required job names are present in pull-request workflows." \
  run_check

# --- Required name not in workflow ---
write_workflow
cat > "${REQ}" <<'TXT'
Migration Check
Type Check
Build
TXT
assert_exit "required name missing from workflow is rejected" 1 run_check
assert_output_contains "missing required name is reported" "Build" run_check

# --- Extra workflow jobs are allowed (main-only exhaustive suites) ---
write_workflow
cat > "${REQ}" <<'TXT'
Migration Check
TXT
assert_exit "extra workflow job is allowed" 0 run_check

# --- Missing required file ---
write_workflow
rm -f "${REQ}"
assert_exit "missing required file is rejected" 1 run_check

# --- Missing workflows directory ---
write_required
rm -rf "${WF_DIR}"
assert_exit "missing workflows directory is rejected" 1 run_check

# --- Empty required list after comments ---
write_workflow
cat > "${REQ}" <<'TXT'
# nothing required

TXT
assert_exit "empty required list after comments is rejected" 1 run_check

# --- Comments / blank lines in required list are ignored ---
write_workflow
cat > "${REQ}" <<'TXT'
# Canonical required checks

Migration Check

# trailing comment
Type Check

TXT
assert_exit "comments and blank lines in required list are ignored" 0 run_check

# --- Job without name: uses the job id ---
write_workflow
cat > "${WF}" <<'YAML'
name: CI
on:
  pull_request:
jobs:
  bare-job:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
  named-job:
    name: Named Job
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
YAML
cat > "${REQ}" <<'TXT'
bare-job
Named Job
TXT
assert_exit "job without name: uses the job id" 0 run_check

# --- A name from a second pull-request workflow counts ---
write_workflow
write_second_workflow ship-loop.yml "$(printf 'on:\n  pull_request:\n    types: [opened, edited, synchronize, reopened]')" "Ship loop"
printf 'Migration Check\nType Check\nShip loop\n' > "${REQ}"
assert_exit "required name only in a second pull-request workflow is accepted" 0 run_check

# --- Renaming the job in the second workflow fails the gate ---
write_second_workflow ship-loop.yml "$(printf 'on:\n  pull_request:')" "Ship loop check"
assert_exit "required name renamed in the second pull-request workflow is rejected" 1 run_check
assert_last_output_contains "renamed name is reported" "Ship loop"

# --- List form on: [push, pull_request] counts ---
write_workflow
write_second_workflow extra.yaml "on: [push, pull_request] # list form" "List Form"
printf 'Migration Check\nList Form\n' > "${REQ}"
assert_exit "on: list form with pull_request counts as a pull-request workflow" 0 run_check

# --- A tag-only workflow cannot satisfy a required name ---
write_workflow
write_second_workflow release.yml "$(printf "on:\n  push:\n    tags: ['v*']")" "Publish packages"
printf 'Migration Check\nPublish packages\n' > "${REQ}"
assert_exit "required name only in a tag-only workflow is rejected" 1 run_check
assert_last_output_contains "tag-only name is reported" "Publish packages"

# --- A workflow with no pull_request trigger is ignored ---
write_workflow
write_second_workflow target.yml "on: [push, pull_request_target]" "Target Only"
printf 'Migration Check\nTarget Only\n' > "${REQ}"
assert_exit "workflow with no pull_request trigger is ignored" 1 run_check

# --- A pull_request item nested under another trigger does not count ---
write_workflow
write_second_workflow nested.yml "$(printf 'on:\n  push:\n    branches:\n      - pull_request')" "Nested Item"
printf 'Migration Check\nNested Item\n' > "${REQ}"
assert_exit "a pull_request item under push branches does not count" 1 run_check

# --- A workflow_call input named pull_request does not count ---
write_workflow
write_second_workflow called.yml "$(printf 'on:\n  workflow_call:\n    inputs:\n      pull_request:\n        type: boolean')" "Called Only"
printf 'Migration Check\nCalled Only\n' > "${REQ}"
assert_exit "a workflow_call input named pull_request does not count" 1 run_check

# --- Layouts a line scanner misread: the gate reads the parsed workflow ---
# write_extra_workflow file — the workflow body comes from stdin.
write_extra_workflow() {
  cat > "${WF_DIR}/$1"
}

write_workflow
write_extra_workflow flowon.yml <<'YAML'
on: { push: { branches: [pull_request] } }
jobs:
  flow-push:
    name: Flow Push
YAML
printf 'Migration Check\nFlow Push\n' > "${REQ}"
assert_exit "a flow-map on: whose only pull_request is a branch name does not count" 1 run_check
assert_output_lacks "the flow-map workflow is not listed as a pull-request workflow" "flowon.yml" run_check

write_workflow
write_extra_workflow nextline.yml <<'YAML'
on: pull_request
jobs:
  bare-job:
    name:
      Shown On Next Line
YAML
printf 'Migration Check\nbare-job\n' > "${REQ}"
assert_exit "a job id does not count when its name: is on the next line" 1 run_check
printf 'Migration Check\nShown On Next Line\n' > "${REQ}"
assert_exit "a name: on the next line is read" 0 run_check

write_workflow
write_extra_workflow folded.yml <<'YAML'
on: pull_request
jobs:
  typecheck2:
    name: Type Check
      Extended
YAML
printf 'Type Check Extended\n' > "${REQ}"
assert_exit "a name: that continues on the next line is read whole" 0 run_check
rm "${WF}"
printf 'Type Check\n' > "${REQ}"
assert_exit "the first line of a continued name: does not count" 1 run_check

for key in '"name"' 'name '; do
  write_workflow
  printf 'on: pull_request\njobs:\n  quoted-key:\n    %s: Shown Name\n' "${key}" > "${WF_DIR}/key.yml"
  printf 'quoted-key\n' > "${REQ}"
  assert_exit "a job id does not count when its name key is written ${key}" 1 run_check
done

write_workflow
write_extra_workflow anchored.yml <<'YAML'
'on': pull_request
env:
  LABEL: &label Anchored Name
jobs:
  quoted:
    name: 'Quoted Name' # shown in the checks list
  aliased:
    name: *label
  folded:
    name: >-
      Folded Name
YAML
write_extra_workflow indented.yml <<'YAML'
on: [pull_request]
jobs:
    four-spaces:
        name: Four Spaces
    flow: { name: Flow Name, runs-on: ubuntu-latest }
YAML
printf 'Quoted Name\nAnchored Name\nFolded Name\nFour Spaces\nFlow Name\n' > "${REQ}"
assert_exit "quoted, commented, aliased, folded, indented and flow names are read" 0 run_check

write_workflow
write_extra_workflow matrix.yml <<'YAML'
on: pull_request
jobs:
  matrix-job:
    strategy:
      matrix:
        os: [ubuntu-latest]
  called:
    name: Called Name
    uses: ./.github/workflows/reusable.yml
YAML
printf 'matrix-job\n' > "${REQ}"
assert_exit "a matrix job's id does not count" 1 run_check
printf 'Called Name\n' > "${REQ}"
assert_exit "a job that calls a reusable workflow does not count" 1 run_check
assert_last_output_contains "the run-time names are explained" "A job with a matrix, or one that calls a reusable workflow, counts for no name."

write_workflow
write_extra_workflow scalar.yml <<'YAML'
on: pull_request
jobs:
  fanned:
    strategy: ${{ fromJSON(needs.plan.outputs.matrix) }}
YAML
printf 'fanned\n' > "${REQ}"
assert_exit "a job whose strategy is one expression is a matrix and its id does not count" 1 run_check

write_workflow
write_extra_workflow expr.yml <<'YAML'
on: pull_request
jobs:
  named:
    name: Build ${{ inputs.target }}
YAML
printf 'Build ${{ inputs.target }}\n' > "${REQ}"
assert_exit "a name: written as an expression is not the name GitHub reports" 1 run_check
printf 'named\n' > "${REQ}"
assert_exit "an expression name does not fall back to the job id" 1 run_check

write_workflow
write_extra_workflow flowtarget.yml <<'YAML'
on: { pull_request_target: {} }
jobs:
  target:
    name: Flow Target
YAML
printf 'Flow Target\n' > "${REQ}"
assert_exit "a flow-map on: with only pull_request_target does not count" 1 run_check

# --- A file the gate cannot read fails, pull-request workflow or not ---
write_workflow
write_extra_workflow twodocs.yml <<'YAML'
on: push
jobs:
  a:
    name: First Doc
---
on: pull_request
jobs:
  b:
    name: Second Doc
YAML
printf 'Second Doc\n' > "${REQ}"
assert_exit "a second YAML document cannot supply a required name" 1 run_check
assert_last_output_contains "the two documents are named" "twodocs.yml holds 2 YAML documents"

write_workflow
write_extra_workflow dup.yml <<'YAML'
on: pull_request
jobs:
  dup:
    name: Dup One
    name: Dup Two
YAML
printf 'Dup One\n' > "${REQ}"
assert_exit "a job with two name: keys fails" 1 run_check
assert_last_output_contains "the repeated key is named" "dup.yml line 5 does not parse"

write_workflow
write_extra_workflow merged.yml <<'YAML'
on: pull_request
x-base: &base
  runs-on: ubuntu-latest
jobs:
  merged:
    <<: *base
    name: Merged Name
YAML
printf 'Merged Name\n' > "${REQ}"
assert_exit "a workflow with a merge key fails" 1 run_check
assert_last_output_contains "the merge key is named" "merged.yml line 6 uses a YAML merge key"

write_workflow
printf 'on: push\njobs: [\n' > "${WF_DIR}/broken.yaml"
write_required
assert_exit "a workflow that does not parse fails even when it is not a pull-request workflow" 1 run_check
assert_last_output_contains "the broken workflow is named" "broken.yaml line 3 does not parse"

write_workflow
write_extra_workflow tagged.yml <<'YAML'
%TAG !e! tag:example.com,2000:
---
on: pull_request
jobs:
  tagged:
    name: Tagged Name
YAML
printf 'Tagged Name\n' > "${REQ}"
assert_exit "a %TAG directive fails" 1 run_check
assert_last_output_contains "the directive is named" "tagged.yml uses a %YAML or %TAG directive"

write_workflow
write_extra_workflow Upper.YML <<'YAML'
on: pull_request
jobs:
  upper:
    name: Upper Name
YAML
printf 'Upper Name\n' > "${REQ}"
assert_exit "a workflow with an upper-case extension fails" 1 run_check
assert_last_output_contains "the upper-case file is named" "Upper.YML has a workflow extension in another letter case"

# --- A required job that can be skipped, or a trigger that can leave it out, fails (#55) ---
# required_job <on block> [job lines] — ci.yml whose job gated supplies the one required name, Gated.
required_job() {
  rm -rf "${WF_DIR}"
  mkdir -p "${WF_DIR}"
  printf 'name: CI\n%s\njobs:\n  first:\n    name: First\n    runs-on: ubuntu-latest\n  gated:\n    name: Gated\n    runs-on: ubuntu-latest\n%b' "$1" "${2:-}" > "${WF}"
  printf 'Gated\n' > "${REQ}"
}
PR_ON=$'on:\n  pull_request:'

required_job "${PR_ON}"
assert_exit "a required job with no condition passes" 0 run_check

required_job "$(printf 'on:\n  pull_request:\n  push:\n    branches: [main]')" '  build:\n    needs: [first, gated]\n    if: always()\n    continue-on-error: true\n'
assert_exit "a job that is not required may have needs:, if: and continue-on-error:" 0 run_check

for job_key in 'if: false' 'if: ${{ always() }}' "if: github.event_name == 'push'" 'if:' 'If: false' 'needs: first' 'needs: [first]' 'needs:\n      - first' 'continue-on-error: true' 'continue-on-error: false'; do
  required_job "${PR_ON}" "    ${job_key}\n"
  shown="$(printf '%b' "${job_key}" | head -1 | cut -d: -f1)"
  assert_exit "a required job with ${job_key} fails" 1 run_check
  assert_last_output_contains "the ${job_key} line is named" "ci.yml line 11 job gated supplies required check Gated and has ${shown}:"
done
assert_last_output_contains "the reason is printed" "A skipped required job reports success, and a workflow that does not run leaves its check pending."

for filter in 'branches: [main]' "branches-ignore: ['release/**']" "paths: ['packages/**']" "paths-ignore: ['docs/**']" 'Paths: [x]'; do
  required_job "$(printf 'on:\n  pull_request:\n    %s' "${filter}")"
  assert_exit "a required job whose pull_request trigger has ${filter} fails" 1 run_check
  assert_last_output_contains "the ${filter} filter is named" "ci.yml supplies required check Gated and its pull_request trigger has ${filter%%:*}: (line 4)"
done

for types in '[closed]:opened, synchronize, reopened' '[opened, synchronize]:reopened' 'opened:synchronize, reopened' '${{ github.event.action }}:opened, synchronize, reopened' '[]:opened, synchronize, reopened'; do
  required_job "$(printf 'on:\n  pull_request:\n    types: %s' "${types%%:*}")"
  assert_exit "types: ${types%%:*} fails" 1 run_check
  assert_last_output_contains "types: ${types%%:*} names the missing types" "its pull_request trigger has types: without ${types#*:} (line 4)"
done

for types in '[opened, edited, synchronize, reopened]' '[reopened, labeled, synchronize, opened]' "$(printf '\n      - opened\n      - synchronize\n      - reopened')"; do
  required_job "$(printf 'on:\n  pull_request:\n    types: %s' "${types}")"
  assert_exit "types: that include the three defaults pass: ${types}" 0 run_check
done

required_job "$(printf 'x-types: &defaults [opened, synchronize, reopened]\non:\n  pull_request:\n    types: *defaults')"
assert_exit "types: read through an alias pass" 0 run_check

for on in 'on: pull_request' 'on: [push, pull_request]' 'on: { pull_request: {} }' "$(printf 'on:\n  pull_request: {}')"; do
  required_job "${on}"
  assert_exit "a pull_request trigger with no filter passes: ${on}" 0 run_check
done

required_job "$(printf 'on:\n  pull_request: opened')"
assert_exit "a pull_request trigger written as a word fails" 1 run_check
assert_last_output_contains "the unreadable trigger is named" "its pull_request trigger has a value it cannot read (line 3)"

required_job "${PR_ON}"
printf "on:\n  pull_request:\n    paths: ['docs/**']\njobs:\n  docs:\n    name: Docs\n" > "${WF_DIR}/docs.yml"
assert_exit "a filtered workflow that supplies no required name passes" 0 run_check

# --- A required name is the check name of one job, in any workflow ---
for second in "on: pull_request" "on: push" "on: workflow_dispatch"; do
  required_job "${PR_ON}"
  printf '%s\njobs:\n  second:\n    name: Gated\n    runs-on: ubuntu-latest\n' "${second}" > "${WF_DIR}/second.yml"
  assert_exit "a second job named Gated in a workflow with ${second} fails" 1 run_check
  assert_last_output_contains "both jobs are named for ${second}" "required check Gated is the name of 2 jobs (ci.yml line 8 job gated, second.yml line 3 job second); keep one"
done

required_job "${PR_ON}" '  gated-again:\n    name: Gated\n'
assert_exit "two jobs named Gated in one workflow fail" 1 run_check
assert_last_output_contains "both jobs in one workflow are named" "required check Gated is the name of 2 jobs (ci.yml line 8 job gated, ci.yml line 11 job gated-again); keep one"

required_job "${PR_ON}"
printf 'on: pull_request\njobs:\n  Gated:\n    strategy:\n      matrix:\n        os: [a]\n    if: false\n' > "${WF_DIR}/matrix.yml"
assert_exit "a matrix job whose id is the required name is not a second supplier" 0 run_check

required_job "${PR_ON}" '  second:\n    name: ${{ '"'Gated'"' }}\n'
assert_exit "known limit: a second job whose name is an expression is not counted as a supplier" 0 run_check

# --- A step with continue-on-error: lets a required job pass when the step fails ---
for step_key in 'continue-on-error: true' 'continue-on-error: false' 'continue-on-error: ${{ github.event_name == '"'push'"' }}' 'Continue-On-Error: true'; do
  required_job "${PR_ON}" "    steps:\n      - run: exit 1\n        ${step_key}\n"
  assert_exit "a required job with a step that has ${step_key} fails" 1 run_check
  assert_last_output_contains "the step ${step_key} is named" "ci.yml line 13 job gated supplies required check Gated and its step 1 has ${step_key%%:*}:"
done

required_job "${PR_ON}" "    steps:\n      - run: echo ok\n      - name: Flaky\n        run: exit 1\n        continue-on-error: true\n"
assert_exit "a named second step with continue-on-error: fails" 1 run_check
assert_last_output_contains "the second step is named" "ci.yml line 15 job gated supplies required check Gated and its step 2 (Flaky) has continue-on-error:"

required_job "$(printf 'x-step: &flaky {run: exit 1, continue-on-error: true}\non:\n  pull_request:')" '    steps:\n      - *flaky\n'
assert_exit "a required job whose step comes from an alias with continue-on-error: fails" 1 run_check
assert_last_output_contains "the aliased step is named" "job gated supplies required check Gated and its step 1 has continue-on-error:"

required_job "${PR_ON}" '    steps:\n      - run: echo ok\n      - uses: actions/checkout@v5\n'
assert_exit "a required job whose steps have no continue-on-error: passes" 0 run_check

required_job "${PR_ON}" '  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n        continue-on-error: true\n'
assert_exit "a step with continue-on-error: in a job that is not required passes" 0 run_check

for steps in '    steps: not-a-list\n' '    steps: ${{ fromJSON(x) }}\n'; do
  required_job "${PR_ON}" "${steps}"
  assert_exit "a required job whose steps it cannot read fails: ${steps}" 1 run_check
  assert_last_output_contains "the unreadable steps are named: ${steps}" "ci.yml line 11 job gated supplies required check Gated and its steps cannot be read"
done

required_job "${PR_ON}" '    steps:\n      - just-a-word\n'
assert_exit "a required job with a step that is not a map fails" 1 run_check
assert_last_output_contains "the unreadable step is named" "ci.yml line 12 job gated supplies required check Gated and its step 1 cannot be read"

# --- The gate stops with an install hint when the yaml package cannot be resolved ---
BARE="${TMP}/bare"
mkdir -p "${BARE}/scripts/gates" "${BARE}/scripts/lib"
cp "${SCRIPT_DIR}"/check-required-ci-jobs.sh "${SCRIPT_DIR}"/check-required-ci-jobs.mjs "${SCRIPT_DIR}"/workflow-yaml.mjs "${BARE}/scripts/gates/"
cp "${SCRIPT_DIR}"/../lib/require-yaml.sh "${BARE}/scripts/lib/"
write_workflow
write_required
run_without_yaml() {
  CI_WORKFLOWS_DIR="${WF_DIR}" REQUIRED_CHECKS="${REQ}" bash "${BARE}/scripts/gates/check-required-ci-jobs.sh"
}
assert_exit "a gate that cannot resolve the yaml package fails" 1 run_without_yaml
assert_last_output_contains "the missing package is named with the fix" "the workflow reader stopped before it checked every file; the yaml package is missing, run pnpm install"

# --- Real repo files (no env override) ---
REAL_REQ="${ROOT_DIR}/.github/workflows/required-checks.txt"
if [ -f "${REAL_REQ}" ]; then
  assert_exit "real repo required-checks.txt names exist in pull-request workflows" 0 \
    bash "${CHECK}"
else
  echo "SKIP: .github/workflows/required-checks.txt not present yet (docs agent racing)"
fi

gate_test_finish
