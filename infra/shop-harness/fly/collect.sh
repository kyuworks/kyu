#!/usr/bin/env bash
# Copy one scenario's report back from a running (or held-open) harness
# machine to this repository, verified byte for byte (#166).
#
#   bash infra/shop-harness/fly/collect.sh -a <app> -m <machine-id> \
#     -s <scenario> -o <out.json>
#
# Runs exactly two `fly machine exec` commands: cat the report, then
# sha256sum it. Nothing else. Never uses `fly ssh` or prints a secret.
set -uo pipefail

APP=""
MACHINE=""
SCENARIO=""
OUT=""

usage() {
  cat <<'EOF' >&2
usage: collect.sh -a|--app <name> -m|--machine <id> -s|--scenario <name> -o|--out <path>
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -a|--app)
      [ $# -ge 2 ] || { usage; exit 2; }
      APP="$2"
      shift 2
      ;;
    -m|--machine)
      [ $# -ge 2 ] || { usage; exit 2; }
      MACHINE="$2"
      shift 2
      ;;
    -s|--scenario)
      [ $# -ge 2 ] || { usage; exit 2; }
      SCENARIO="$2"
      shift 2
      ;;
    -o|--out)
      [ $# -ge 2 ] || { usage; exit 2; }
      OUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ -z "${APP}" ] || [ -z "${MACHINE}" ] || [ -z "${SCENARIO}" ] || [ -z "${OUT}" ]; then
  usage
  exit 2
fi

# Refused before fly is ever called: a slash or a space in the scenario name
# could change what path gets cat'd or sha256sum'd on the machine.
if ! [[ "${SCENARIO}" =~ ^[a-z-]+$ ]]; then
  echo "FAIL: scenario name must match ^[a-z-]+\$: ${SCENARIO}" >&2
  exit 2
fi

REPORT_PATH="/reports/${SCENARIO}.json"

extract_stdout() {
  node -e '
let s = ""
process.stdin.on("data", (d) => { s += d })
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(s)
    const row = Array.isArray(parsed) ? parsed[0] : parsed
    if (row === null || typeof row !== "object" || typeof row.stdout !== "string") {
      process.exit(1)
    }
    process.stdout.write(row.stdout)
  } catch {
    process.exit(1)
  }
})
'
}

# $(...) strips trailing newlines; run.ts writes the report with none, so
# this never diverges from what sha256sum hashed on the machine.
if ! CONTENT="$(fly machine exec "${MACHINE}" "cat ${REPORT_PATH}" --json -a "${APP}" | extract_stdout)"; then
  echo "FAIL: could not read ${REPORT_PATH} from machine ${MACHINE}" >&2
  exit 1
fi

if ! SHA_LINE="$(fly machine exec "${MACHINE}" "sha256sum ${REPORT_PATH}" --json -a "${APP}" | extract_stdout)"; then
  echo "FAIL: could not sha256sum ${REPORT_PATH} from machine ${MACHINE}" >&2
  exit 1
fi

REMOTE_SHA="$(printf '%s' "${SHA_LINE}" | awk '{print $1}')"
LOCAL_SHA="$(printf '%s' "${CONTENT}" | shasum -a 256 | awk '{print $1}')"

if [ -z "${REMOTE_SHA}" ] || [ "${REMOTE_SHA}" != "${LOCAL_SHA}" ]; then
  echo "FAIL: sha256 mismatch for ${REPORT_PATH}: remote=${REMOTE_SHA:-<none>} local=${LOCAL_SHA}" >&2
  exit 1
fi

if ! printf '%s' "${CONTENT}" | node -e 'JSON.parse(require("node:fs").readFileSync(0, "utf8"))' >/dev/null 2>&1; then
  echo "FAIL: ${REPORT_PATH} content did not parse as JSON" >&2
  exit 1
fi

printf '%s' "${CONTENT}" > "${OUT}"
echo "collected scenario=${SCENARIO} bytes=$(printf '%s' "${CONTENT}" | wc -c | tr -d ' ') sha256=${LOCAL_SHA} -> ${OUT}"
