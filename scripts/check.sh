#!/usr/bin/env bash
# check.sh — quiet canonical local check
#
# One command for "is this tree good?":
#   pnpm check
#
# Success: no stdout/stderr. Exit 0.
# Failure: print the failed step, the first actionable error, and the path
# of the full log under .artifacts/check/. Exit non-zero.
# CHECK_VERBOSE=1 also prints a bounded tail (human debugging).
#
# Scheduler: leading `gates` steps run one after another. Then format, lint,
# and typecheck run one after another so oxlint is not killed (SIGKILL 137)
# on the 8GB sandbox when every suite starts at once. Remaining test steps
# start at the same time. Each named step runs at most once. Without a
# leading `gates` step (CHECK_STEPS in unit tests), steps stay serial so
# injected cases keep their original contract.
#
# Covers: gates, format, lint, typecheck, unit tests, gate self-tests. Not the
# Hatchet integration suite (pnpm test:integration needs the engine).
#
# Env overrides (for tests):
#   CHECK_STEPS       newline-separated "name<TAB>command"
#                     (default: the set below)
#   CHECK_LOG_DIR     where full step logs are copied on failure
#                     (default: <repo>/.artifacts/check)
#   CHECK_VERBOSE     if 1, also print a bounded tail (default unset)
#   CHECK_TAIL_LINES  tail line count when CHECK_VERBOSE=1 (default 80)
#   CHECK_MAX_BYTES   hard cap on the printed tail (default 32768)
#
# Normal local loop (typical leaves): bash scripts/check-changed.sh.
# This file stays the exhaustive local backstop.
#
# Usage:
#   bash scripts/check.sh
#   pnpm check
#   CHECK_STEPS=$'ok\ttrue' bash scripts/check.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

bash scripts/lib/check-node-engine.sh

TAIL_LINES="${CHECK_TAIL_LINES:-80}"
MAX_BYTES="${CHECK_MAX_BYTES:-32768}"
LOG_DIR="${CHECK_LOG_DIR:-${ROOT_DIR}/.artifacts/check}"
VERBOSE="${CHECK_VERBOSE:-0}"

if ! [[ "${TAIL_LINES}" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL: CHECK_TAIL_LINES must be a positive integer (got ${TAIL_LINES})" >&2
  exit 2
fi
if ! [[ "${MAX_BYTES}" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL: CHECK_MAX_BYTES must be a positive integer (got ${MAX_BYTES})" >&2
  exit 2
fi

default_steps() {
  cat <<'EOF'
gates	bash scripts/verify-gates.sh
format	pnpm format:check
lint	pnpm lint
typecheck	pnpm typecheck
typecheck-tests	pnpm typecheck:tests
schemas-test	pnpm --filter @kinesin/schemas test
sdk-test	pnpm --filter @kinesin/sdk test
self-tests	bash scripts/verify-self-tests.sh
EOF
}

TMP="$(mktemp -d)"
bg_pids=()

cleanup() {
  if [ "${#bg_pids[@]}" -gt 0 ]; then
    kill "${bg_pids[@]}" 2>/dev/null || true
    wait "${bg_pids[@]}" 2>/dev/null || true
  fi
  rm -rf "${TMP}"
}
on_signal() {
  local sig="${1:-130}"
  trap - INT TERM EXIT
  cleanup
  exit "${sig}"
}
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

STEPS_FILE="${TMP}/steps"
if [ -n "${CHECK_STEPS:-}" ]; then
  printf '%s\n' "${CHECK_STEPS}" > "${STEPS_FILE}"
else
  default_steps > "${STEPS_FILE}"
fi

extract_first_error() {
  local file="$1"
  local line=""
  if [ -s "${file}" ]; then
    line="$(grep -i -E -m1 \
      'error TS[0-9]+|(^|[[:space:]])(error|fail|failed|assertionerror)(:|[[:space:]])|✖|FAIL[[:space:]]' \
      "${file}" || true)"
    if [ -z "${line}" ]; then
      line="$(grep -m1 -v -E '^[[:space:]]*$' "${file}" || true)"
    fi
  fi
  if [ -z "${line}" ]; then
    printf '%s' "(no output)"
    return
  fi
  printf '%s' "${line}" | tr -s '[:space:]' ' ' | cut -c1-400
}

print_bounded_tail() {
  local file="$1"
  local tail_file="${TMP}/tail.txt"
  if [ ! -s "${file}" ]; then
    echo "(no output)"
    return
  fi
  tail -n "${TAIL_LINES}" "${file}" > "${tail_file}"
  local size
  size="$(wc -c < "${tail_file}" | tr -d '[:space:]')"
  if [ "${size}" -gt "${MAX_BYTES}" ]; then
    tail -c "${MAX_BYTES}" "${tail_file}"
    printf '\n(truncated to %s bytes)\n' "${MAX_BYTES}"
  else
    cat "${tail_file}"
  fi
}

safe_log_name() {
  # Flatten ids such as selftest:scripts/foo.test.sh so cp does not
  # treat slashes as directories. Keep ':' and '/' distinct.
  local raw="$1"
  local flat
  flat="$(printf '%s' "${raw}" | tr '/:' '__' | tr -cd 'A-Za-z0-9._-')"
  if [ -z "${flat}" ]; then
    flat="step"
  fi
  printf '%s' "${flat}"
}

report_failure() {
  local name="$1"
  local out="$2"
  mkdir -p "${LOG_DIR}"
  local log="${LOG_DIR}/$(safe_log_name "${name}").log"
  cp "${out}" "${log}"
  {
    echo "FAILED: ${name}"
    echo "First error: $(extract_first_error "${out}")"
    echo "log: ${log}"
    if [ "${VERBOSE}" = "1" ]; then
      echo
      echo "---- last ${TAIL_LINES} lines ----"
      print_bounded_tail "${out}"
      echo "----"
    fi
  } >&2
}

run_step_capture() {
  local cmd="$1" out_file="$2" rc_file="$3"
  set +e
  bash -c "${cmd}" >"${out_file}" 2>&1
  local rc=$?
  set -e
  printf '%s\n' "${rc}" > "${rc_file}"
}

read_rc() {
  local rc_file="$1"
  if [ -s "${rc_file}" ]; then
    cat "${rc_file}"
  else
    printf '%s\n' "1"
  fi
}

step_names=()
step_cmds=()
while IFS= read -r line || [ -n "${line}" ]; do
  case "${line}" in
    ''|'#'*) continue ;;
  esac
  local_name="${line%%	*}"
  local_cmd="${line#*	}"
  if [ "${local_name}" = "${line}" ]; then
    echo "FAIL: CHECK_STEPS line is missing a TAB between name and command:" >&2
    echo "  ${line}" >&2
    exit 2
  fi
  step_names+=("${local_name}")
  step_cmds+=("${local_cmd}")
done < "${STEPS_FILE}"

is_serial_prefix() {
  # A selected step id carries its package, e.g. "lint:packages/sdk" — compare
  # the prefix before the first colon, not the whole id, or a gate-triggered
  # run falls out of the serial window and every lint/typecheck step starts
  # at once (oxlint OOM on the 8 GB sandbox).
  case "${1%%:*}" in
    gates | format | lint | typecheck | typecheck-tests) return 0 ;;
    *) return 1 ;;
  esac
}

step_count="${#step_names[@]}"
serial_end="${step_count}"
if [ "${step_count}" -gt 0 ] && [ "${step_names[0]}" = "gates" ]; then
  serial_end=0
  while [ "${serial_end}" -lt "${step_count}" ] && is_serial_prefix "${step_names[${serial_end}]}"; do
    serial_end=$((serial_end + 1))
  done
fi

i=0
while [ "${i}" -lt "${serial_end}" ]; do
  out_file="${TMP}/step-${i}.out"
  rc_file="${TMP}/step-${i}.rc"
  run_step_capture "${step_cmds[${i}]}" "${out_file}" "${rc_file}"
  rc="$(read_rc "${rc_file}")"
  if [ "${rc}" -ne 0 ]; then
    report_failure "${step_names[${i}]}" "${out_file}"
    exit "${rc}"
  fi
  i=$((i + 1))
done

if [ "${serial_end}" -lt "${step_count}" ]; then
  i="${serial_end}"
  while [ "${i}" -lt "${step_count}" ]; do
    out_file="${TMP}/step-${i}.out"
    rc_file="${TMP}/step-${i}.rc"
    run_step_capture "${step_cmds[${i}]}" "${out_file}" "${rc_file}" &
    bg_pids+=($!)
    i=$((i + 1))
  done
  for pid in "${bg_pids[@]}"; do
    wait "${pid}" || true
  done
  bg_pids=()

  i="${serial_end}"
  while [ "${i}" -lt "${step_count}" ]; do
    rc="$(read_rc "${TMP}/step-${i}.rc")"
    if [ "${rc}" -ne 0 ]; then
      report_failure "${step_names[${i}]}" "${TMP}/step-${i}.out"
      exit "${rc}"
    fi
    i=$((i + 1))
  done
fi

exit 0
