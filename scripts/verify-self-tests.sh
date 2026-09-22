#!/usr/bin/env bash
# verify-self-tests.sh — run the shell self-tests that sit beside the gates.
#
# Gates guard the repo; these suites guard the gates. They were invoked by
# hand and by nobody else, so a regression in gate logic was caught by no
# automation.
#
# Discovery, not a list: every *.test.sh under scripts/ and .agents/skills/
# runs. A new self-test is picked up with no registration step, because a
# registration step is exactly what went unmaintained before.
#
# Prints one duration line per suite, slowest first. Each failure also prints
# every FAIL line the suite logged and a bounded tail. All suites run, so one
# CI trip reports every broken suite rather than only the first.
#
# Suites that write the working tree must not overlap the others. Mark them
# with the token `verify-self-tests: exclusive`; they run in a git worktree
# so they can share the pool.
#
# Env overrides (for tests):
#   SELF_TESTS_DIR   — one directory to search instead of the defaults
#   SELF_TESTS_JOBS  — parallel suites (default: nproc)
#   SELF_TESTS_LIST  — set to 1 to print the discovered suites and exit 0
#                      without running any
#
# Usage:
#   bash scripts/verify-self-tests.sh

set -uo pipefail

# git exports these when it runs a hook, and they override `git -C`, so a suite
# that builds a throwaway repo would commit into the real one instead. Cleared
# before repo discovery so discovery uses the working directory. List shared
# with scripts/lib/run-isolated-selftest.sh: scripts/lib/git-env.sh.
SELF_TESTS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=./lib/git-env.sh
source "${SELF_TESTS_LIB_DIR}/git-env.sh"
unset "${GIT_HOOK_ENV_VARS[@]}"

physical_file() {
  printf '%s/%s' "$(cd "$(dirname "$1")" && pwd -P)" "$(basename "$1")"
}

ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "${ROOT}"

FAIL_TAIL_LINES=40
# A suite that carries on after a failed assertion pushes it past the tail.
FAIL_LINE_LIMIT=200

# The pipeline skills keep their suites beside their scripts under
# .agents/skills/, and the Fly deploy scripts keep theirs under infra/, so
# scripts/ alone would leave both out of the nightly.
if [ -n "${SELF_TESTS_DIR:-}" ]; then
  SEARCH_DIRS=("${SELF_TESTS_DIR}")
else
  SEARCH_DIRS=("${ROOT}/scripts" "${ROOT}/.agents/skills" "${ROOT}/infra")
fi

# This runner's own suite drives the runner, so discovering it would recurse.
# The Gate Self Tests job names it in its own step instead.
SELF="$(basename "${BASH_SOURCE[0]}" .sh).test.sh"

for dir in "${SEARCH_DIRS[@]}"; do
  if [ ! -d "${dir}" ]; then
    echo "FAIL: not a directory: ${dir}" >&2
    exit 1
  fi
done

SUITES=()
while IFS= read -r _suite; do
  SUITES+=("${_suite}")
done < <(find "${SEARCH_DIRS[@]}" -name '*.test.sh' -not -name "${SELF}" | sort)

if [ "${#SUITES[@]}" -eq 0 ]; then
  echo "FAIL: no *.test.sh found under ${SEARCH_DIRS[*]}" >&2
  exit 1
fi

if [ "${SELF_TESTS_LIST:-0}" = 1 ]; then
  printf '%s\n' "${SUITES[@]#"${ROOT}"/}"
  exit 0
fi

JOBS="${SELF_TESTS_JOBS:-}"
if [ -z "${JOBS}" ]; then
  JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
fi
case "${JOBS}" in
  ''|*[!0-9]*|0) JOBS=1 ;;
esac

WAIT_N=0
if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 3 ]; }; then
  WAIT_N=1
fi

now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    printf '%s' "${EPOCHREALTIME}"
  else
    date +%s
  fi
}

WHERE="$(printf '%s ' "${SEARCH_DIRS[@]#"${ROOT}"/}")"
echo "[verify:self-tests] ${#SUITES[@]} suites under ${WHERE% } (jobs=${JOBS})"

RESULTS="$(mktemp -d)"
ISOLATE_DEST=""

cleanup() {
  local wt
  if [ -f "${RESULTS}/worktrees" ]; then
    while IFS= read -r wt; do
      [ -n "${wt}" ] || continue
      git -C "${ROOT}" worktree remove --force "${wt}" >/dev/null 2>&1 || rm -rf "${wt}"
    done < "${RESULTS}/worktrees"
    git -C "${ROOT}" worktree prune >/dev/null 2>&1 || true
  fi
  rm -rf "${RESULTS}"
}
trap cleanup EXIT

# Overlay tracked dirty files and untracked (non-ignored) files so an
# exclusive suite runs the working tree, not a stale HEAD checkout.
overlay_worktree() {
  local src="$1" dest="$2" path dir
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    dir="$(dirname "${path}")"
    mkdir -p "${dest}/${dir}"
    if [ -e "${src}/${path}" ] || [ -L "${src}/${path}" ]; then
      rm -rf "${dest}/${path}"
      cp -a "${src}/${path}" "${dest}/${path}"
    else
      rm -rf "${dest}/${path}"
    fi
  done < <(
    git -C "${src}" diff --name-only HEAD
    git -C "${src}" ls-files --others --exclude-standard
  )
}

# Copy, do not symlink. pnpm refuses to run when node_modules resolves
# outside the worktree (ERR_PNPM_UNSAFE_MODULES_DIR). Hardlinks would let
# a worktree install mutate the caller's tree.
copy_node_modules() {
  local src="$1" dest="$2" rel dir phys
  while IFS= read -r rel; do
    [ -n "${rel}" ] || continue
    rel="${rel#./}"
    dir="$(dirname "${rel}")"
    mkdir -p "${dest}/${dir}"
    if [ -e "${dest}/${rel}" ]; then
      continue
    fi
    phys="$(cd "${src}/${rel}" && pwd -P)"
    if ! cp -a "${phys}" "${dest}/${rel}"; then
      return 1
    fi
  done < <(cd "${src}" && find . -name .git -prune -o -name node_modules \( -type d -o -type l \) -print -prune | LC_ALL=C sort)
}

# 0: ISOLATE_DEST set. 1: suite is not in this repo, run in place. 2: failed.
isolate_exclusive() {
  local orig log rel dest lock spins
  orig="$(physical_file "$1")"
  log="$2"
  ISOLATE_DEST=""
  rel="${orig#"${ROOT}"/}"
  if [ "${orig}" = "${rel}" ]; then
    return 1
  fi
  dest="${RESULTS}/wt-${idx}"
  lock="${RESULTS}/wt.lock"
  spins=0
  while ! mkdir "${lock}" 2>/dev/null; do
    spins=$((spins + 1))
    if [ "${spins}" -gt 200 ]; then
      echo "FAIL: timed out waiting to add a worktree for ${rel}" >>"${log}"
      return 2
    fi
    sleep 0.05
  done
  if ! git -C "${ROOT}" worktree add --detach "${dest}" >>"${log}" 2>&1; then
    rmdir "${lock}" 2>/dev/null || true
    echo "FAIL: git worktree add failed for ${rel}" >>"${log}"
    return 2
  fi
  printf '%s\n' "${dest}" >> "${RESULTS}/worktrees"
  rmdir "${lock}" 2>/dev/null || true
  overlay_worktree "${ROOT}" "${dest}"
  if ! copy_node_modules "${ROOT}" "${dest}"; then
    echo "FAIL: cannot copy node_modules into the exclusive worktree for ${rel}" >>"${log}"
    return 2
  fi
  ISOLATE_DEST="${dest}"
  return 0
}

run_suite() {
  local idx="$1" orig suite rel log start end rc iso_rc
  orig="$(physical_file "$2")"
  suite="${orig}"
  rel="${orig#"${ROOT}"/}"
  log="${RESULTS}/${idx}.log"
  : >"${log}"
  if grep -qF 'verify-self-tests: exclusive' "${orig}"; then
    isolate_exclusive "${orig}" "${log}"
    iso_rc=$?
    if [ "${iso_rc}" -eq 0 ]; then
      suite="${ISOLATE_DEST}/${rel}"
    elif [ "${iso_rc}" -ne 1 ]; then
      awk -v s="$(now)" -v e="$(now)" 'BEGIN { printf "%.1f", e - s }' > "${RESULTS}/${idx}.dur"
      printf '%s\n' "${rel}" > "${RESULTS}/${idx}.rel"
      printf '1\n' > "${RESULTS}/${idx}.rc"
      return
    fi
  fi
  start="$(now)"
  set +e
  if [ "${suite}" != "${orig}" ]; then
    ( cd "${ISOLATE_DEST}" && bash "${suite}" ) >>"${log}" 2>&1
  else
    bash "${suite}" >>"${log}" 2>&1
  fi
  rc=$?
  set +e
  end="$(now)"
  awk -v s="${start}" -v e="${end}" 'BEGIN { printf "%.1f", e - s }' > "${RESULTS}/${idx}.dur"
  printf '%s\n' "${rel}" > "${RESULTS}/${idx}.rel"
  printf '%s\n' "${rc}" > "${RESULTS}/${idx}.rc"
}

run_pool() {
  local limit="$1"
  shift
  local running=0 suite
  for suite in "$@"; do
    while [ "${running}" -ge "${limit}" ]; do
      if [ "${WAIT_N}" -eq 1 ]; then
        wait -n || true
        running=$((running - 1))
      else
        wait || true
        running=0
      fi
    done
    run_suite "${idx}" "${suite}" &
    running=$((running + 1))
    idx=$((idx + 1))
  done
  wait || true
}

parallel=()
exclusive_serial=()
for suite in "${SUITES[@]}"; do
  if grep -qF 'verify-self-tests: exclusive' "${suite}"; then
    orig="$(physical_file "${suite}")"
    rel="${orig#"${ROOT}"/}"
    if [ "${orig}" = "${rel}" ]; then
      exclusive_serial+=("${suite}")
      continue
    fi
  fi
  parallel+=("${suite}")
done

idx=0
if [ "${#parallel[@]}" -gt 0 ]; then
  run_pool "${JOBS}" "${parallel[@]}"
fi
if [ "${#exclusive_serial[@]}" -gt 0 ]; then
  run_pool 1 "${exclusive_serial[@]}"
fi

times=()
failed=()
i=0
while [ "${i}" -lt "${#SUITES[@]}" ]; do
  rel="$(cat "${RESULTS}/${i}.rel")"
  dur="$(cat "${RESULTS}/${i}.dur")"
  rc="$(cat "${RESULTS}/${i}.rc")"
  times+=("${dur}	${rel}")
  if [ "${rc}" -ne 0 ]; then
    failed+=("${rel}")
    echo ""
    echo "FAIL: ${rel}" >&2
    # -a: one NUL byte anywhere turns the whole log into "Binary file matches".
    fail_lines="$(grep -an 'FAIL' "${RESULTS}/${i}.log" | head -n "${FAIL_LINE_LIMIT}" | cut -c1-400)"
    if [ -n "${fail_lines}" ]; then
      echo "----- FAIL lines -----" >&2
      printf '%s\n' "${fail_lines}" >&2
    fi
    echo "----- last ${FAIL_TAIL_LINES} lines -----" >&2
    tail -n "${FAIL_TAIL_LINES}" "${RESULTS}/${i}.log" >&2
    echo "--------------------------------" >&2
  fi
  i=$((i + 1))
done

if [ "${#times[@]}" -gt 0 ]; then
  printf '%s\n' "${times[@]}" | sort -t $'\t' -k1,1nr | while IFS=$'\t' read -r dur rel; do
    printf '[verify:self-tests] %6ss  %s\n' "${dur}" "${rel}"
  done
fi

if [ "${#failed[@]}" -gt 0 ]; then
  echo "" >&2
  echo "FAIL: ${#failed[@]} of ${#SUITES[@]} self-test suites failed:" >&2
  printf '  - %s\n' "${failed[@]}" >&2
  echo "" >&2
  echo "Run one directly to iterate: bash <path>" >&2
  exit 1
fi

echo "[verify:self-tests] All ${#SUITES[@]} suites passed."
